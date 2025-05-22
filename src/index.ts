import { Hono } from "hono";
import {
  File,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import { v4 as uuidv4 } from "uuid";
import * as mm from "music-metadata";

type Bindings = {
  AUDIO_FILES: R2Bucket;
  AUDIO_KV: KVNamespace;
  COVER_FILES: R2Bucket;
};

const app = new Hono<{
  Bindings: Bindings;
}>();

type MP3Meta = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
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

/**
 * Upload a new MP3 audio file
 * @route POST /audio
 * @param {FormData} request.body.audio - The MP3 file to upload
 * @returns {Object} JSON response with upload ID
 * @throws {400} If no file is provided or file type is invalid
 */
app.post("/audio", async (c) => {
  const contentType = c.req.header("content-type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return c.text("Expected multipart/form-data", 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("audio");

  if (!file || typeof file === "string") {
    return c.text("No Audio uploaded", 400);
  }

  if (file.type !== "audio/mpeg" && file.type !== "audio/mp3") {
    return c.text("Invalid file type", 400);
  }

  const id = uuidv4();
  const key = `${id}.mp3`;

  // We need to clone the file for metadata extraction since we'll consume the stream later
  const fileBuffer = await file.arrayBuffer();

  // Extract metadata using music-metadata
  let metadata;
  let coverArtInfo;

  try {
    metadata = await mm.parseBuffer(fileBuffer, { mimeType: file.type });

    // Check if there's cover art in the file
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const coverArt = metadata.common.picture[0];
      const coverArtId = `${id}-cover`;
      const coverKey = `${coverArtId}.${
        coverArt.format.split("/")[1] || "jpg"
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
      `Error extracting metadata: ${error}`,
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
    id,
    filename: file.name,
    contentType: file.type,
    size: file.size,
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

  await c.env.AUDIO_KV.put(`audio:${id}`, JSON.stringify(meta));

  return c.json({ message: "Uploaded", id });
});

/**
 * Get a list of all uploaded audio files
 * @route GET /audios
 * @returns {Object} JSON response with array of audio metadata
 */
app.get("/audios", async (c) => {
  const { keys } = await c.env.AUDIO_KV.list({ prefix: "audio:" });

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
app.get("/audio/:id/meta", async (c) => {
  const id = c.req.param("id");
  const raw = await c.env.AUDIO_KV.get(`audio:${id}`);
  if (!raw) return c.text("Not found", 404);

  return c.json(JSON.parse(raw));
});

/**
 * Stream an audio file
 * @route GET /audio/:id
 * @param {string} request.params.id - The ID of the audio file
 * @returns {Stream} Audio file stream with appropriate content-type
 * @throws {404} If audio file is not found
 */
app.get("/audio/:id", async (c) => {
  const id = c.req.param("id");
  const object = await c.env.AUDIO_FILES.get(`${id}.mp3`);
  if (!object) return c.text("File not found", 404);

  return c.body(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "audio/mpeg",
    },
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
app.put("/audio/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.AUDIO_FILES.get(`audio:${id}`);
  if (!existing) return c.text("Not found", 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.text("No file provided", 400);

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

  return c.json({ message: "Updated", id });
});

/**
 * Delete an audio file
 * @route DELETE /audio/:id
 * @param {string} request.params.id - The ID of the audio file to delete
 * @returns {Object} JSON response with deletion confirmation
 */
app.delete("/audio/:id", async (c) => {
  const id = c.req.param("id");

  await Promise.all([
    c.env.AUDIO_FILES.delete(`${id}.mp3`),
    c.env.AUDIO_KV.delete(`audio:${id}`),
  ]);

  return c.json({ message: "Deleted", id });
});

export default app;
