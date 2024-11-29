export const FORMAT_CONTENT_TYPE = new Map([
  ["raw-16khz-16bit-mono-pcm", "audio/basic"],
  ["raw-48khz-16bit-mono-pcm", "audio/basic"],
  ["raw-8khz-8bit-mono-mulaw", "audio/basic"],
  ["raw-8khz-8bit-mono-alaw", "audio/basic"],

  ["raw-16khz-16bit-mono-truesilk", "audio/SILK"],
  ["raw-24khz-16bit-mono-truesilk", "audio/SILK"],

  ["riff-16khz-16bit-mono-pcm", "audio/x-wav"],
  ["riff-24khz-16bit-mono-pcm", "audio/x-wav"],
  ["riff-48khz-16bit-mono-pcm", "audio/x-wav"],
  ["riff-8khz-8bit-mono-mulaw", "audio/x-wav"],
  ["riff-8khz-8bit-mono-alaw", "audio/x-wav"],

  ["audio-16khz-32kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-16khz-64kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-16khz-128kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-24khz-48kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-24khz-96kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-24khz-160kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-48khz-96kbitrate-mono-mp3", "audio/mpeg"],
  ["audio-48khz-192kbitrate-mono-mp3", "audio/mpeg"],

  ["webm-16khz-16bit-mono-opus", "audio/webm; codec=opus"],
  ["webm-24khz-16bit-mono-opus", "audio/webm; codec=opus"],

  ["ogg-16khz-16bit-mono-opus", "audio/ogg; codecs=opus; rate=16000"],
  ["ogg-24khz-16bit-mono-opus", "audio/ogg; codecs=opus; rate=24000"],
  ["ogg-48khz-16bit-mono-opus", "audio/ogg; codecs=opus; rate=48000"],
]);

class SynthesisRequest {
  requestId: string;
  bufferChunks: Uint8Array[];
  successCallback: (buffer: Uint8Array) => void;
  errorCallback: (error: Error) => void;
  constructor(
    requestId: string,
    successCallback: (buffer: Uint8Array) => void,
    errorCallback: (error: Error) => void,
  ) {
    this.requestId = requestId;
    this.bufferChunks = [];
    this.successCallback = successCallback;
    this.errorCallback = errorCallback;
  }
  send(ssml: string, format: string, send: (data: string) => void) {
    const configData = {
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: "false",
              wordBoundaryEnabled: "false",
            },
            outputFormat: format,
          },
        },
      },
    };
    const configMessage = `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(configData)}`;
    console.debug(`Start to send config：${this.requestId}\n`, configMessage);
    send(configMessage);

    // 发送SSML消息
    const ssmlMessage = `X-Timestamp:${Date()}\r\nX-RequestId:${this.requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
    console.debug(`Start to send SSML：${this.requestId}\n`, ssmlMessage);
    send(ssmlMessage);
  }

  handleString(data: string) {
    if (data.includes("Path:turn.start")) {
      // 开始传输
      console.debug(`Turn Start：${this.requestId}...`);
    } else if (data.includes("Path:turn.end")) {
      // 结束传输
      console.debug(
        `Turn End：${this.requestId} with ${this.bufferChunks.length} chunks...`,
      );
      const result = concatenate(this.bufferChunks);
      this.successCallback(result);
    }
  }
  handleBuffer(data: Uint8Array) {
    this.bufferChunks.push(data);
  }
}

function parseRequestId(data: string) {
  const pattern = /X-RequestId:(?<id>[a-z|0-9]*)/;
  const matches = data.match(pattern);
  return matches?.groups?.id ?? null;
}

// Path:audio\r\n
const AUDIO_SEP = [80, 97, 116, 104, 58, 97, 117, 100, 105, 111, 13, 10];

function handleMessage(message: MessageEvent) {
  const data = message.data;
  switch (typeof data) {
    case "string": {
      const requestId = parseRequestId(data);
      console.debug(`Received string (${requestId}): ${data}\n`);
      return { requestId, data };
    }
    case "object": {
      const bufferData = new Uint8Array(data);
      const contentIndex =
        indexOfUint8Array(bufferData, AUDIO_SEP) + AUDIO_SEP.length;
      const headers = new TextDecoder("utf-8").decode(
        bufferData.subarray(2, contentIndex),
      );
      const requestId = parseRequestId(headers);
      console.debug(
        `Received binary/audio (${requestId})：length: ${data.byteLength}`,
      );

      return { requestId, data: bufferData.subarray(contentIndex) };
    }
  }
}

export class Service {
  private ws: WebSocket | null = null;
  private timerId: ReturnType<typeof setTimeout> | undefined = undefined;

  private requestMap = new Map<string, SynthesisRequest>();

  constructor() {
    this.requestMap = new Map();
  }

  private reset() {
    this.ws = null;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
    this.requestMap.clear();
  }

  private async connect(): Promise<WebSocket> {
    const connectionId = randomUUID().toLowerCase();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connectionId}`;
    const ws = new WebSocket(url);
    ws.addEventListener("close", (closeEvent) => {
      // 服务器会自动断开空闲超过30秒的连接
      const { code, reason } = closeEvent;
      for (const [id, request] of this.requestMap) {
        request.errorCallback(
          new Error(`Connection Closed for ${id}. ${reason} ${code}`),
        );
      }
      this.reset();
      console.info(`Connection Closed： ${reason} ${code}`);
    });

    ws.addEventListener("message", (message) => {
      const { requestId, data } = handleMessage(message);
      if (requestId == null) {
        console.debug("Received unrecognized message");
        return;
      }
      const request = this.requestMap.get(requestId);
      if (request) {
        typeof data === "string"
          ? request.handleString(data)
          : request.handleBuffer(data);
      } else {
        console.debug("Received message for unknown request");
        return;
      }
    });

    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve(ws);
      });
      ws.addEventListener("error", (error) => {
        console.error(`Connection failed: ${error}`);
        if (this.ws) {
          this.ws.close();
          for (const [id, request] of this.requestMap) {
            request.errorCallback(
              new Error(`Connection failed：${id} ${error}`),
            );
          }
        } else {
          reject(`Connection failed： ${error}`);
        }
      });
    });
  }

  public async convert(ssml: string, format: string) {
    if (this.ws == null || this.ws.readyState !== WebSocket.OPEN) {
      console.info("Starting connection...");
      const connection = await this.connect();
      this.ws = connection;
      console.info("Connected");
    }
    const requestId = randomUUID().toLowerCase();
    const result = new Promise<Uint8Array>((resolve, reject) => {
      // 等待服务器返回后这个方法才会返回结果
      const request = new SynthesisRequest(requestId, resolve, reject);
      this.requestMap.set(requestId, request);
      console.debug("Request received", requestId);
      // 发送配置消息
      // biome-ignore lint/style/noNonNullAssertion: ws should be initialized above
      request.send(ssml, format, (data) => this.ws!.send(data));
    });
    // 收到请求，清除超时定时器
    if (this.timerId) {
      console.debug("Received request, clearing timeout timer");
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
    // 设置定时器，超过10秒没有收到请求，主动断开连接
    console.debug("Creating timeout timer");
    this.timerId = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000);
        console.debug("Connection Closed by client due to inactivity");
        this.timerId = undefined;
      }
    }, 10000);

    const data = await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        // 如果超过 20 秒没有返回结果，则清除请求并返回超时
        setTimeout(() => {
          reject("Convert timeout");
        }, 10000);
      }),
    ]);
    this.requestMap.delete(requestId);
    console.info(`Convert Complete：${requestId}`);
    console.info(`${this.requestMap.size} tasks remaining`);
    return data;
  }
}

function randomUUID() {
  return crypto.randomUUID().replaceAll("-", "");
}

function concatenate(uint8arrays: Uint8Array[]) {
  const totalLength = uint8arrays.reduce(
    (total, uint8array) => total + uint8array.byteLength,
    0,
  );

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const uint8array of uint8arrays) {
    result.set(uint8array, offset);
    offset += uint8array.byteLength;
  }

  return result;
}

function indexOfUint8Array(buffer: Uint8Array, separator: number[]) {
  if (separator.length === 0) {
    return 0;
  }

  const len = buffer.length - separator.length;
  let i = 0;

  outer: while (i <= len) {
    if (buffer[i] === separator[0]) {
      for (let j = 1; j < separator.length; j++) {
        if (buffer[i + j] !== separator[j]) {
          i++;
          continue outer;
        }
      }
      return i;
    }
    i++;
  }
  return -1;
}
