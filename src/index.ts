#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";

const API_KEY = process.env.DIFY_API_KEY;
if (!API_KEY) {
  throw new Error("DIFY_API_KEY environment variable is required");
}

interface FileInput {
  type: string;
  transfer_method: string;
  url?: string;
  local_file?: string;
  upload_file_id?: string;
}

interface ChatRequest {
  query: string;
  imageFilePath?: string;
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

const isValidChatRequest = (args: any): args is ChatRequest => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof args.query === "string" &&
    (args.imageFilePath === undefined ||
      (typeof args.imageFilePath === "string" &&
        fs.existsSync(args.imageFilePath)))
  );
};

class DifyServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: "dify-chat-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: "https://api.dify.ai/v1",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async uploadFile(
    filePath: string,
    user: string
  ): Promise<FileUploadResponse> {
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("user", user);

    try {
      const response = await this.axiosInstance.post(
        "/files/upload",
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        }
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          `File upload failed: ${
            error.response?.data?.message || error.message
          }`
        );
      }
      throw error;
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "antd-component-codegen-mcp-tool",
          description:
            "Send a message to Dify chat API for generating antd biz components code",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The message to send",
              },
              imageFilePath: {
                type: "string",
                description: "The image file absolute path to send",
              },
            },
            required: ["query"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "antd-component-codegen-mcp-tool") {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidChatRequest(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid chat request arguments"
        );
      }

      try {
        const requestArgs = { ...request.params.arguments };
        let files: FileInput[] = [];

        if (requestArgs.imageFilePath) {
          const uploadResponse = await this.uploadFile(
            requestArgs.imageFilePath,
            "mcp-user"
          );
          files.push({
            type: "image",
            transfer_method: "local_file",
            upload_file_id: uploadResponse.id,
          });
        }

        const response = await this.axiosInstance.post(
          "/chat-messages",
          {
            query: requestArgs.query,
            inputs: requestArgs.inputs || {},
            files,
            user: "mcp-user",
            response_mode: "streaming",
          },
          {
            responseType: "stream",
          }
        );

        let fullResponse = "";
        let isError = false;

        // Process the streaming response
        for await (const chunk of response.data) {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const jsonData = JSON.parse(line.slice(6));
                if (jsonData.error) {
                  isError = true;
                  fullResponse = jsonData.error;
                  break;
                }
                fullResponse += jsonData.answer || "";
              } catch (e) {
                console.error("Failed to parse SSE data:", e);
              }
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: fullResponse,
            },
          ],
          isError,
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: "text",
                text: `${error.response?.data?.message || error.message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  async run() {
    /**
     * stdio 进行对外的进程间通信
     * 相当把 dify-mcp-server 作为子进程运行在 MCP Client 中
     * 然后 MCP Client、dify-mcp-server之间 通过 stdio 进行通信
     */
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Dify MCP server running on stdio");
  }
}

const server = new DifyServer();
server.run().catch(console.error);
