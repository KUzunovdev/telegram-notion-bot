import axios from "axios";
import OpenAI from "openai";
import { toFile } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Downloads a voice file from Telegram servers and returns it as a Buffer.
 * @param {string} fileId - Telegram file_id from ctx.message.voice.file_id
 * @param {string} botToken - Telegram bot token
 * @returns {Promise<Buffer>}
 */
export async function downloadVoice(fileId, botToken) {
  // Step 1: get file path from Telegram
  const fileInfoRes = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  );
  const filePath = fileInfoRes.data.result.file_path;

  // Step 2: download the OGG binary
  const fileRes = await axios.get(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
    { responseType: "arraybuffer" }
  );

  return Buffer.from(fileRes.data);
}

/**
 * Transcribes an audio buffer via OpenAI Whisper.
 * @param {Buffer} audioBuffer - OGG audio data
 * @returns {Promise<string>} transcription text
 */
export async function transcribe(audioBuffer) {
  const file = await toFile(audioBuffer, "voice.ogg", { type: "audio/ogg" });

  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "text",
  });

  return response.trim();
}
