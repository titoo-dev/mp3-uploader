import { Hono } from 'hono';
import { R2Bucket } from '@cloudflare/workers-types';

type Bindings = {
	MP3_FILES: R2Bucket;
};

const app = new Hono<{
	Bindings: Bindings;
}>();

app.post('/upload', async (c) => {
	const contentType = c.req.header('content-type') || '';

	if (!contentType.includes('multipart/form-data')) {
		return c.text('Expected multipart/form-data', 400);
	}

	const formData = await c.req.formData();
	const file = formData.get('file');

	if (!file || typeof file === 'string') {
		return c.text('No file uploaded', 400);
	}

	if (file.type !== 'audio/mpeg' && file.type !== 'audio/mp3') {
		return c.text('Invalid file type', 400);
	}

	const fileName = file.name || `upload-${Date.now()}.mp3`;

	// Save to R2
	await c.env.MP3_FILES.put(fileName, file.stream(), {
		httpMetadata: {
			contentType: file.type,
		},
	});

	return c.text(`File ${fileName} uploaded successfully to R2`);
});

export default app;
