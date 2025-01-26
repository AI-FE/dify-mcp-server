#!/usr/bin/env node
import axios from "axios";
import FormData from "form-data";
import fs from "fs";

interface FileInput {
  type: string;
  transfer_method: string;
  url?: string;
  local_file?: string;
  upload_file_id?: string;
}

interface FileUploadResponse {
  id: string;
  name: string;
  size: number;
  extension: string;
  mime_type: string;
  created_by: number;
  created_at: number;
}

async function uploadFile(
  axiosInstance: any,
  filePath: string,
  user: string
): Promise<FileUploadResponse> {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("user", user);

  const response = await axiosInstance.post("/files/upload", formData, {
    headers: {
      ...formData.getHeaders(),
    },
  });

  return response.data;
}

async function sendChatMessage(query: string, imageFilePath?: string) {
  const API_KEY = process.env.DIFY_API_KEY;
  if (!API_KEY) {
    throw new Error("DIFY_API_KEY environment variable is required");
  }

  const axiosInstance = axios.create({
    baseURL: "https://api.dify.ai/v1",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  try {
    let files: FileInput[] = [];

    if (imageFilePath && fs.existsSync(imageFilePath)) {
      const uploadResponse = await uploadFile(
        axiosInstance,
        imageFilePath,
        "cli-user"
      );
      files.push({
        type: "image",
        transfer_method: "local_file",
        upload_file_id: uploadResponse.id,
      });
    }

    const response = await axiosInstance.post(
      "/chat-messages",
      {
        query,
        inputs: {},
        files,
        user: "cli-user",
        response_mode: "streaming",
      },
      {
        responseType: "stream",
      }
    );

    // Process the streaming response
    for await (const chunk of response.data) {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const jsonData = JSON.parse(line.slice(6));
            if (jsonData.error) {
              console.error("Error:", jsonData.error);
              return;
            }
            if (jsonData.answer) {
              process.stdout.write(jsonData.answer);
            }
          } catch (e) {
            console.error("Failed to parse SSE data:", e);
          }
        }
      }
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("Error:", error.response?.data?.message || error.message);
    } else {
      console.error("Unexpected error:", error);
    }
  }
}

// Get command line arguments
const query = process.argv[2];
const imageFilePath = process.argv[3];

if (!query) {
  console.error(
    "Usage: DIFY_API_KEY=**** node dify-command-tool.js <query> [imageFilePath]"
  );
  process.exit(1);
}

sendChatMessage(query, imageFilePath).catch(console.error);
