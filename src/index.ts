import { Hono } from 'hono';
import { File, KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { v4 as uuidv4 } from 'uuid';
import * as mm from 'music-metadata';
import { cors } from 'hono/cors';
import cryptojs from 'crypto-js';

type Bindings = {
	AUDIO_FILES: R2Bucket;
	AUDIO_KV: KVNamespace;
	COVER_FILES: R2Bucket;
	PROJECT_KV: KVNamespace;
};

const app = new Hono<{
	Bindings: Bindings;
}>();

type Project = {
	id: string;
	name: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	lyricsId?: string;
	audioId: string;
	assetIds?: string[];
};

type MP3Meta = {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: string;
	fileHash: string; // Add hash field to identify duplicates
	metadata?: {
		title?: string;
		artist?: string;
		album?: string;
		year?: string;
		genre?: string[];
		duration?: number;
	};
	coverArt?: {
		id: string;
		format: string;
		size: number;
	};
};

app.use('*', cors());

async function saveProject(env: KVNamespace, project: Project) {
	project.updatedAt = new Date().toISOString();
	await env.put(`project:${project.id}`, JSON.stringify(project));
}

/**
 * Upload a new MP3 audio file
 * @route POST /audio
 * @param {FormData} request.body.audio - The MP3 file to upload
 * @returns {Object} JSON response with upload ID
 * @throws {400} If no file is provided or file type is invalid
 */
app.post('/audio', async (c) => {
	const contentType = c.req.header('content-type') || '';

	if (!contentType.includes('multipart/form-data')) {
		return c.text('Expected multipart/form-data', 400);
	}

	const formData = await c.req.formData();
	const file = formData.get('audio');

	if (!file || typeof file === 'string') {
		return c.text('No Audio uploaded', 400);
	}

	if (file.type !== 'audio/mpeg' && file.type !== 'audio/mp3') {
		return c.text('Invalid file type', 400);
	}

	// We need to clone the file for metadata extraction since we'll consume the stream later
	const fileBuffer = await file.arrayBuffer();
	// Convert ArrayBuffer to Uint8Array for music-metadata parsing
	const uint8Array = new Uint8Array(fileBuffer);

	// Generate a hash of the file content
	const fileHash = await generateFileHash(uint8Array);

	// Check if a file with the same hash already exists
	const existingFile = await findFileByHash(c.env.AUDIO_KV, fileHash);

	if (existingFile) {
		// Return information about the existing file instead of creating a duplicate
		return c.json(
			{
				message: 'File already exists',
				duplicate: true,
				existingFile: {
					id: existingFile.id,
					filename: existingFile.filename,
					metadata: existingFile.metadata,
				},
			},
			400
		);
	}

	const audioId = uuidv4();
	const key = `${audioId}.mp3`;

	// Extract metadata using music-metadata
	let metadata;
	let coverArtInfo;

	try {
		metadata = await mm.parseBuffer(uint8Array, { mimeType: file.type });

		// Check if there's cover art in the file
		if (metadata.common.picture && metadata.common.picture.length > 0) {
			const coverArt = metadata.common.picture[0];
			const coverArtId = `${audioId}-cover`;
			const coverKey = `${coverArtId}.${
				coverArt.format.split('/')[1] || 'jpg'
			}`;

			// Save cover art to R2
			await c.env.COVER_FILES.put(coverKey, coverArt.data, {
				httpMetadata: {
					contentType: coverArt.format,
				},
			});

			coverArtInfo = {
				id: coverArtId,
				format: coverArt.format,
				size: coverArt.data.length,
			};
		}
	} catch (error) {
		return c.text(
			`Error extracting metadata: ${
				error instanceof Error ? error.message : String(error)
			}`,
			500
		);
	}

	// Save to R2
	await c.env.AUDIO_FILES.put(key, new Uint8Array(fileBuffer), {
		httpMetadata: {
			contentType: file.type,
		},
	});

	const meta: MP3Meta = {
		id: audioId,
		filename: file.name,
		contentType: file.type,
		size: file.size,
		fileHash: fileHash, // Store the hash for future duplicate checks
		createdAt: new Date().toISOString(),
		metadata: metadata
			? {
					title: metadata.common.title,
					artist: metadata.common.artist,
					album: metadata.common.album,
					year: metadata.common.year?.toString(),
					genre: metadata.common.genre,
					duration: metadata.format.duration,
			  }
			: undefined,
		coverArt: coverArtInfo,
	};

	await c.env.AUDIO_KV.put(`audio:${audioId}`, JSON.stringify(meta));

	// create project
	const projectId = uuidv4();
	const now = new Date().toISOString();

	const project: Project = {
		id: projectId,
		name: `${meta.metadata?.title || 'New Project'} - ${
			meta.metadata?.artist || 'Unknown Artist'
		}`,
		createdAt: now,
		updatedAt: now,
		audioId: audioId,
	};

	await saveProject(c.env.PROJECT_KV, project);

	return c.json({ message: 'Uploaded', id: audioId });
});

/**
 * Generate a SHA-256 hash from file content
 * @param {Uint8Array} fileContent - The file content to hash
 * @returns {Promise<string>} - Hex string of the hash
 */
async function generateFileHash(fileContent: Uint8Array): Promise<string> {
	// Convert Uint8Array to WordArray that CryptoJS can use
	const wordArray = cryptojs.lib.WordArray.create(fileContent);

	// Generate SHA-256 hash using CryptoJS
	const hash = cryptojs.SHA256(wordArray);

	// Return the hash as a hex string
	return hash.toString(cryptojs.enc.Hex);
}

/**
 * Find a file with the given hash in the KV store
 * @param {KVNamespace} kv - The KV namespace to search
 * @param {string} hash - File hash to search for
 * @returns {Promise<MP3Meta|null>} - Returns file metadata if found, null otherwise
 */
async function findFileByHash(
	kv: KVNamespace,
	hash: string
): Promise<MP3Meta | null> {
	// List all audio files
	const { keys } = await kv.list({ prefix: 'audio:' });

	// Check each file for matching hash
	for (const key of keys) {
		const raw = await kv.get(key.name);
		if (!raw) continue;

		const meta = JSON.parse(raw) as MP3Meta;
		if (meta.fileHash === hash) {
			return meta;
		}
	}

	return null;
}

/**
 * Get a list of all uploaded audio files
 * @route GET /audios
 * @returns {Object} JSON response with array of audio metadata
 */
app.get('/audios', async (c) => {
	const { keys } = await c.env.AUDIO_KV.list({ prefix: 'audio:' });

	if (keys.length === 0) {
		return c.json({ audios: [] });
	}

	const audioMetas = await Promise.all(
		keys.map(async ({ name }) => {
			const raw = await c.env.AUDIO_KV.get(name);
			if (!raw) return null;
			return JSON.parse(raw) as MP3Meta;
		})
	);

	// Filter out any null values (in case a KV read failed)
	const validAudios = audioMetas.filter((meta) => meta !== null);

	return c.json({ audios: validAudios });
});

/**
 * Get metadata for a specific audio file
 * @route GET /audio/:id/meta
 * @param {string} request.params.id - The ID of the audio file
 * @returns {Object} JSON response with audio metadata
 * @throws {404} If audio with given ID is not found
 */
app.get('/audio/:id/meta', async (c) => {
	const id = c.req.param('id');
	const raw = await c.env.AUDIO_KV.get(`audio:${id}`);
	if (!raw) return c.text('Not found', 404);

	return c.json(JSON.parse(raw));
});

/**
 * Stream an audio file with range request support
 * @route GET /audio/:id
 * @param {string} request.params.id - The ID of the audio file
 * @returns {Stream} Audio file stream with appropriate content-type
 * @throws {404} If audio file is not found
 */
app.get('/audio/:id', async (c) => {
	const id = c.req.param('id');
	const object = await c.env.AUDIO_FILES.get(`${id}.mp3`);
	if (!object) return c.text('File not found', 404);

	const rangeHeader = c.req.header('range');
	const contentType = object.httpMetadata?.contentType || 'audio/mpeg';
	const size = object.size;

	// Set default headers
	const headers: { [key: string]: string } = {
		'Content-Type': contentType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'public, max-age=3600',
	};

	// If no range is requested, return the entire file
	if (!rangeHeader) {
		headers['Content-Length'] = size.toString();
		return c.body(object.body, { headers });
	}

	// Parse the range header
	const rangeParts = rangeHeader.replace(/bytes=/, '').split('-');
	const start = parseInt(rangeParts[0], 10);
	const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : size - 1;

	// Check if the range is valid
	if (isNaN(start) || isNaN(end) || start >= size || end >= size) {
		// Return 416 Range Not Satisfiable if range is invalid
		headers['Content-Range'] = `bytes */${size}`;
		return c.body(null, {
			status: 416, // Range Not Satisfiable
			headers,
		});
	}

	// Calculate the chunk size
	const chunkSize = end - start + 1;

	// Get the requested range from R2
	const rangeObject = await c.env.AUDIO_FILES.get(`${id}.mp3`, {
		range: { offset: start, length: chunkSize },
	});

	if (!rangeObject) return c.text('Range not available', 416);

	// Set additional headers for partial content
	headers['Content-Length'] = chunkSize.toString();
	headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

	// Return 206 Partial Content for range requests
	return c.body(rangeObject.body, {
		status: 206, // Partial Content
		headers,
	});
});

/**
 * Update an existing audio file
 * @route PUT /audio/:id
 * @param {string} request.params.id - The ID of the audio file to update
 * @param {FormData} request.body.file - The new MP3 file
 * @returns {Object} JSON response with update confirmation
 * @throws {404} If audio with given ID is not found
 * @throws {400} If no file is provided
 */
app.put('/audio/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.AUDIO_FILES.get(`audio:${id}`);
	if (!existing) return c.text('Not found', 404);

	const formData = await c.req.formData();
	const file = formData.get('file') as File;
	if (!file) return c.text('No file provided', 400);

	await c.env.AUDIO_FILES.put(`${id}.mp3`, file.stream(), {
		httpMetadata: { contentType: file.type },
	});

	const existingMetaRaw = await existing.text();

	const meta: MP3Meta = {
		...(JSON.parse(existingMetaRaw) as MP3Meta),
		filename: file.name,
		contentType: file.type,
		size: file.size,
		createdAt: new Date().toISOString(), // or keep original
	};

	await c.env.AUDIO_FILES.put(`audio:${id}`, JSON.stringify(meta));

	return c.json({ message: 'Updated', id });
});

/**
 * Delete an audio file
 * @route DELETE /audio/:id
 * @param {string} request.params.id - The ID of the audio file to delete
 * @returns {Object} JSON response with deletion confirmation
 */
app.delete('/audio/:id', async (c) => {
	const id = c.req.param('id');

	await Promise.all([
		c.env.AUDIO_FILES.delete(`${id}.mp3`),
		c.env.AUDIO_KV.delete(`audio:${id}`),
	]);

	return c.json({ message: 'Deleted', id });
});

/**
 * Get cover art for an audio file
 * @route GET /audio/:id/cover
 * @param {string} request.params.id - The ID of the audio file
 * @returns {Stream} Cover art image stream with appropriate content-type
 * @throws {404} If cover art is not found
 */
app.get('/audio/:id/cover', async (c) => {
	const id = c.req.param('id');

	// Get audio metadata to check if it has cover art
	const raw = await c.env.AUDIO_KV.get(`audio:${id}`);
	if (!raw) return c.text('Audio file not found', 404);

	const meta = JSON.parse(raw) as MP3Meta;

	// Check if this audio file has cover art
	if (!meta.coverArt || !meta.coverArt.id) {
		return c.text('No cover art available for this audio', 404);
	}

	// Construct the cover art key based on the format
	const coverArtFormat = meta.coverArt.format.split('/')[1] || 'jpg';
	const coverKey = `${meta.coverArt.id}.${coverArtFormat}`;

	// Get the cover art from R2
	const coverObject = await c.env.COVER_FILES.get(coverKey);
	if (!coverObject) return c.text('Cover art file not found', 404);

	// Return the cover art with proper content type
	return c.body(coverObject.body, {
		headers: {
			'Content-Type': meta.coverArt.format || 'image/jpeg',
		},
	});
});

export default app;
