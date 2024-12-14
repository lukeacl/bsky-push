import WebSocket from "ws";
import { Decoder } from "@toondepauw/node-zstd";
import EventEmitter from "events";

import Logger from "./logger.js";

const _PING_INTERVAL = 30000;
const _PING_TIMEOUT = 30000;
const _RECONNECT_INTERVAL = 10000;
const _LATENCY_INTERVAL = 10000;

export default class JetstreamClient extends EventEmitter {
  static shared() {
    if (!this._instance) {
      this._instance = new JetstreamClient();
    }
    return this._instance;
  }

  constructor() {
    super();
    this._lastLatency = 0;
    this._repos = [];
    this._collections = [];
  }

  async getDictionary() {
    const response = await fetch(
      "https://github.com/bluesky-social/jetstream/raw/refs/heads/main/pkg/models/zstd_dictionary",
    );
    return Buffer.from(await response.arrayBuffer());
  }

  sendOptionsUpdate() {
    if (!this._ws) return;
    this._ws.send(
      JSON.stringify({
        type: "options_update",
        payload: {
          wantedDids: this._repos,
          wantedCollections: this._collections,
        },
      }),
    );
  }

  filterRepos(repos) {
    this._repos = repos;
    this.sendOptionsUpdate();
  }

  filterCollections(collections) {
    this._collections = collections;
    this.sendOptionsUpdate();
  }

  async start() {
    if (!this._decoder) {
      this._decoder = new Decoder(await this.getDictionary());
    }
    this._ws = new WebSocket(
      "wss://jetstream1.us-west.bsky.network/subscribe?compress=true&requireHello=true",
      {},
    );
    this._ws.on("open", () => {
      Logger.shared().info("Connected.");
      this.sendOptionsUpdate();
      this.heartbeat();
    });
    this._ws.on("pong", () => {
      Logger.shared().info(`Pong!`);
      clearTimeout(this._heartbeatTimeout);
      setTimeout(() => {
        this.heartbeat();
      }, _PING_INTERVAL);
    });
    this._ws.on("message", async (message) => this.message(message));
    this._ws.on("error", (error) => {
      Logger.shared().info(`Error: ${error}`);
      this._ws.terminate();
    });
    this._ws.on("close", () => {
      Logger.shared().info("Disconnected.");
      setTimeout(() => {
        this.start();
      }, _RECONNECT_INTERVAL);
    });
  }

  heartbeat() {
    clearTimeout(this._heartbeatTimeout);
    this._ws.ping();
    Logger.shared().info(`Ping...`);
    this._heartbeatTimeout = setTimeout(() => {
      Logger.shared().info("Timeout.");
      this._ws.terminate();
    }, _PING_TIMEOUT);
  }

  async message(message) {
    const decoded = await this._decoder.decode(message);
    const data = JSON.parse(decoded.toString("utf8"));
    this.emit(data.kind, data);
    if (Date.now() - this._lastLatency >= _LATENCY_INTERVAL) {
      this._lastLatency = Date.now();
      const latency = Date.now() - data.time_us / 1000;
      Logger.shared().info(`Latency: ${Math.round(latency * 1000) / 1000}ms`);
    }
  }
}
