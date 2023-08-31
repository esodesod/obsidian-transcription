import { TranscriptionSettings } from "src/main";
import { Notice, requestUrl, RequestUrlParam, TFile, Vault } from "obsidian";
import { format } from "date-fns";
import { paths, components } from "./types/swiftink";
import { payloadGenerator, PayloadData } from "src/utils";
import { StatusBar } from "./status";
import { SupabaseClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";

// This class is the parent for transcription engines. It takes settings and a file as an input and returns a transcription as a string

type TranscriptionBackend = (file: TFile) => Promise<string>;

export class TranscriptionEngine {
	settings: TranscriptionSettings;
	vault: Vault;
	status_bar: StatusBar | null;
	supabase: SupabaseClient;

	transcriptionEngine: TranscriptionBackend

	transcription_engines: { [key: string]: TranscriptionBackend } = {
		"swiftink": this.getTranscriptionSwiftink,
		"whisper_asr": this.getTranscriptionWhisperASR
	}

	constructor(settings: TranscriptionSettings, vault: Vault, statusBar: StatusBar | null, supabase: SupabaseClient) {
		this.settings = settings;
		this.vault = vault;
		this.status_bar = statusBar;
		this.supabase = supabase;
	}

	segmentsToTimestampedString(segments: components['schemas']['TimestampedTextSegment'][], timestampFormat: string): string {
		let transcription = '';
		for (const segment of segments) {
			// Start and end are second floats with 2 decimal places
			// Convert to milliseconds and then to a date object
			let start = new Date(segment.start * 1000);
			let end = new Date(segment.end * 1000);

			// Subtract timezone to get UTC
			start = new Date(start.getTime() + start.getTimezoneOffset() * 60000);
			end = new Date(end.getTime() + end.getTimezoneOffset() * 60000);

			// Format the date objects using the timestamp format
			const start_formatted = format(start, timestampFormat);
			const end_formatted = format(end, timestampFormat);

			const segment_string = `${start_formatted} - ${end_formatted}: ${segment.text}\n`;
			transcription += segment_string;
		}
		return transcription;
	}

	/**
	 * 
	 * @param {TFile} file 
	 * @returns {Promise<string>} promise that resolves to a string containing the transcription 
	 */
	async getTranscription(file: TFile): Promise<string> {
		if (this.settings.debug) console.log(`Transcription engine: ${this.settings.transcription_engine}`);
		const start = new Date();
		this.transcriptionEngine = this.transcription_engines[this.settings.transcription_engine];
		return this.transcriptionEngine(file).then((transcription) => {
			if (this.settings.debug) console.log(`Transcription: ${transcription}`);
			if (this.settings.debug) console.log(`Transcription took ${new Date().getTime() - start.getTime()} ms`);
			return transcription;
		})
	}

	async getTranscriptionWhisperASR(file: TFile): Promise<string> {
		// Now that we have the form data payload as an array buffer, we can pass it to requestURL
		// We also need to set the content type to multipart/form-data and pass in the Boundary string

		const payload_data: PayloadData = {}
		payload_data['audio_file'] = new Blob([await this.vault.readBinary(file)]);
		const [request_body, boundary_string] = await payloadGenerator(payload_data);

		const options: RequestUrlParam = {
			method: 'POST',
			url: `${this.settings.whisperASRUrl}/asr?task=transcribe&language=en`,
			contentType: `multipart/form-data; boundary=----${boundary_string}`,
			body: request_body
		};

		return requestUrl(options).then(async (response) => {
			if (this.settings.debug) console.log(response);
			// WhisperASR returns a JSON object with a text field containing the transcription and segments field

			// Pull transcription from either response.text or response.json.text
			if (typeof response.text === 'string') return response.text;
			else return response.json.text;

		}).catch((error) => {
			if (this.settings.debug) console.error(error);
			return Promise.reject(error);
		});
	}

	async getTranscriptionSwiftink(file: TFile): Promise<string> {
		// Declare constants for the API
		let api_base: string
		if (this.settings.dev) api_base = 'http://localhost:8000'
		// if (this.settings.dev) api_base = 'https://api.swiftink.io'
		else api_base = 'https://api.swiftink.io'

		const token = await this.supabase.auth.getSession().then((res) => { return res.data?.session?.access_token });
		const id = await this.supabase.auth.getSession().then((res) => { return res.data?.session?.user?.id });
		if (token === undefined) return Promise.reject('No token found');
		if (id === undefined) return Promise.reject('No user id found');

		const fileStream = await this.vault.readBinary(file);
		const filename = file.name.replace(/[^a-zA-Z0-9.]+/g, '-');

		const uploadPromise = new Promise<tus.Upload>((resolve, reject) => {
			const upload = new tus.Upload(new Blob([fileStream]), {
				endpoint: `https://auth.swiftink.io/storage/v1/upload/resumable`,
				retryDelays: [0, 3000, 5000, 10000, 20000],
				headers: {
					authorization: `Bearer ${token}`,
					'x-upsert': 'true', // set upsert to true to overwrite existing files
				},
				uploadDataDuringCreation: true,
				metadata: {
					bucketName: 'swiftink-upload',
					objectName: `${id}/${filename}`,
				},
				chunkSize: 6 * 1024 * 1024, // Supabase only supports 6MB chunks
				onError: (error) => {
					if (this.settings.debug) console.log('Failed because: ' + error);
					reject(error);
				},
				onProgress: (bytesUploaded, bytesTotal) => {
					const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
					if (this.settings.debug) console.log(bytesUploaded, bytesTotal, percentage + '%');
				},
				onSuccess: () => {
					if (this.settings.debug) console.log(`Successfully uploaded ${filename} to Swiftink`);
					resolve(upload);
				},
			});

			upload.start()
		})


		try {
			await uploadPromise;
			new Notice(`Successfully uploaded ${filename} to Swiftink`);
		} catch (error) {
			if (this.settings.debug) console.log('Failed to upload to Swiftink: ', error);
			return Promise.reject(error);
		}

		// Now lets create the transcription job

		// Lets first construct a fake public URL for the file, Swiftink can parse this URL to get the bucket and object name
		const fileUrl = `https://auth.swiftink.io/storage/v1/object/public/swiftink-upload/${id}/${filename}`

		const url = `${api_base}/transcripts/`
		const headers = { 'Authorization': `Bearer ${token}` }
		const body: paths['/transcripts/']['post']['requestBody']['content']['application/json'] = {
			name: filename,
			url: fileUrl,
		}

		const options: RequestUrlParam = {
			method: 'POST',
			url: url,
			headers: headers,
			body: JSON.stringify(body)
		};

		const transcript_create_res = await requestUrl(options);

		// const transcript_create_res = await axios.post(url, body, { headers: headers })

		// let transcript: components['schemas']['TranscriptSchema'] = transcript_create_res.data
		let transcript: components['schemas']['TranscriptSchema'] = transcript_create_res.json
		if (this.settings.debug) console.log(transcript);

		// Poll the API until the transcription is complete
		return new Promise((resolve, reject) => {
			let tries = 0
			const poll = setInterval(async () => {
				// const transcript_res = await axios.get(`${api_base}/transcripts/${transcript.id}`, { headers: headers })
				// transcript = transcript_res.data
				const options: RequestUrlParam = {
					method: 'GET',
					url: `${api_base}/transcripts/${transcript.id}`,
					headers: headers
				}
				const transcript_res = await requestUrl(options);
				transcript = transcript_res.json;
				console.log(transcript)
				if (transcript.status === 'transcribed' || transcript.status === 'completed') {
					clearInterval(poll)
					new Notice(`Successfully transcribed ${filename} with Swiftink`);
					if (this.settings.timestamps) resolve(this.segmentsToTimestampedString(transcript.text_segments, this.settings.timestampFormat));
					else resolve(transcript.text ? transcript.text : '');
				}
				else if (transcript.status == 'failed') {
					if (this.settings.debug) console.error('Swiftink failed to transcribe the file');
					clearInterval(poll)
					reject('Swiftink failed to transcribe the file');
				}
				else if (transcript.status == 'validation_failed') {
					if (this.settings.debug) console.error('Swiftink has detected an invalid file');
					clearInterval(poll)
					reject('Swiftink has detected an invalid file');
				}
				else if (tries > 20) {
					if (this.settings.debug) console.error('Swiftink took too long to transcribe the file');
					clearInterval(poll)
					reject('Swiftink took too long to transcribe the file')
				}
				tries++;
			}, 3000)
		})
	}
}
