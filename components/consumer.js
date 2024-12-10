import { AtpAgent, AppBskyGraphListitem } from "@atproto/api";
import ntfy from "@cityssm/ntfy-publish";
import EventEmitter from "events";

import Receiver from "./receiver.js";

export default class Consumer extends EventEmitter {
  static shared() {
    if (!this._instance) {
      this._instance = new Consumer();
    }
    return this._instance;
  }

  constructor() {
    super();
    this._lastLatency = 0;
    this._lastExcessLatency = 0;
    this._wantedDIDs = [];
    this._didRKeys = {};
    this._didHandles = {};
    this._didDisplayNames = {};
    this._rKeyDIDs = {};
    this._agent = new AtpAgent({ service: "https://public.api.bsky.app" });
    this.start();
  }

  async start() {
    await this.fetchWantedRepos();
    const receiver = Receiver.shared();
    const updateFilterRepos = () => {
      receiver.filterRepos([...this._wantedDIDs, process.env.MY_DID]);
    };
    updateFilterRepos();
    receiver.on("create", async (time, repo, collection, rkey, record) => {
      if (collection === "app.bsky.graph.listitem") {
        if (repo === process.env.MY_DID) {
          const { list, subject: did } = record;
          if (list === process.env.LIST_URI) {
            await this.watch(did, rkey);
            updateFilterRepos();
          }
        }
      }
      if (collection === "app.bsky.feed.post") {
        if (this._wantedDIDs.includes(repo)) {
          this.handlePost(repo, rkey, record);
        }
      }
    });
    receiver.on("delete", async (time, repo, collection, rkey) => {
      if (collection === "app.bsky.graph.listitem") {
        if (repo === process.env.MY_DID) {
          await this.unwatch(rkey);
          updateFilterRepos();
        }
      }
    });
    receiver.on("latency", async (latency) => {
      const oneMinute = 1000 * 60 * 1;
      const fiveMinutes = 1000 * 60 * 5;
      if (latency >= 5 && Date.now() - this._lastExcessLatency >= oneMinute) {
        this._lastLatency = Date.now();
        this._lastExcessLatency = Date.now();
        console.log("Latency:", latency.toFixed(3) * 1);
        /*await ntfy(
          this.parseNotifyPayload({
            title: "Latency",
            message: `${latency.toFixed(3)}s`,
          }),
        );*/
      } else if (Date.now() - this._lastLatency >= oneMinute) {
        //make it one for now
        this._lastLatency = Date.now();
        console.log("Latency:", latency.toFixed(3) * 1);
      }
    });
    receiver.on("connected", async () => {
      await ntfy(
        this.parseNotifyPayload({
          title: "Connected",
          message: `Firehose connected.`,
          //clickURL: "",
        }),
      );
    });
    receiver.on("disconnected", async (error) => {
      await ntfy(
        this.parseNotifyPayload({
          title: "Disconnected",
          message: `${error}`,
          //clickURL: "",
        }),
      );
    });
    receiver.on("disconnectedSlow", async () => {
      await ntfy(
        this.parseNotifyPayload({
          title: "Disconnected",
          message: `Firehose disconnected. We're too slow.`,
          //clickURL: "",
        }),
      );
    });
    receiver.start();
  }

  parseNotifyPayload(payload) {
    return {
      ...(process.env.NTFY_BASE_URL
        ? { server: process.env.NTFY_BASE_URL }
        : {}),
      topic: process.env.NTFY_TOPIC,
      ...payload,
    };
  }

  async fetchWantedRepos() {
    const response = await this._agent.app.bsky.graph.getList({
      list: process.env.LIST_URI,
    });
    for (const item of response.data.items) {
      const { uri } = item;
      const [, , , , rkey] = uri.split("/");
      const { did, handle, displayName } = item.subject;
      this._didRKeys[did] = rkey;
      this._didHandles[did] = handle;
      this._didDisplayNames[did] = displayName || handle;
      this._rKeyDIDs[rkey] = did;
    }
    this._wantedDIDs = response.data.items.map((item) => item.subject.did);
    console.log("Watching:", this._wantedDIDs.length);
    await ntfy(
      this.parseNotifyPayload({
        title: "Watching",
        message: `${this._wantedDIDs.length} account${this._wantedDIDs.length === 1 ? "" : "s"}`,
        //clickURL: "",
      }),
    );
  }

  async watch(did, rkey) {
    try {
      const response = await this._agent.app.bsky.actor.getProfile({
        actor: did,
      });
      const { handle, displayName } = response.data;
      this._didRKeys[did] = rkey;
      this._didHandles[did] = handle;
      this._didDisplayNames[did] = displayName || handle;
      this._rKeyDIDs[rkey] = did;
      this._wantedDIDs.push(did);
      console.log("Watch:", did, handle, this._wantedDIDs.length);
      await ntfy(
        this.parseNotifyPayload({
          title: `Watching (${this._wantedDIDs.length})`,
          message: `${handle}`,
          //clickURL: "",
        }),
      );
    } catch (error) {}
  }

  async unwatch(rkey) {
    try {
      if (Object.hasOwn(this._rKeyDIDs, rkey) === false) return;
      const did = this._rKeyDIDs[rkey];
      const response = await this._agent.app.bsky.actor.getProfile({
        actor: did,
      });
      const { handle, displayName } = response.data;
      this._wantedDIDs = this._wantedDIDs.filter(
        (wantedDID) => wantedDID !== did,
      );
      console.log("Unwatch:", did, handle, this._wantedDIDs.length);
      await ntfy(
        this.parseNotifyPayload({
          title: `Unwatching (${this._wantedDIDs.length})`,
          message: `${handle}`,
          //clickURL: "",
        }),
      );
    } catch (error) {}
  }

  async isFollowing(did) {
    const response = await this._agent.app.bsky.graph.getRelationships({
      actor: process.env.MY_DID,
      others: [did],
    });
    if (response.data.relationships.length === 0) return false;
    const relationship = response.data.relationships[0];
    if (!relationship.following) return false;
    return true;
  }

  async getHandle(did) {
    const response = await this._agent.app.bsky.actor.getProfile({
      actor: did,
    });
    const { handle, displayName } = response.data;
    this._didHandles[did] = handle;
    this._didDisplayNames[did] = displayName || handle;
    return response.data.handle;
  }

  async handlePost(did, rkey, record) {
    try {
      let { text, reply } = record;
      const handle = this._didHandles[did];
      if (!handle) {
        handle = await this.getHandle(did);
      }
      if (reply) {
        if (process.env.INCLUDE_REPLIES != "1") return;
        const { parent } = reply;
        const { uri } = parent;
        const [, , replyingToDID] = uri.split("/");
        if (replyingToDID === process.env.MY_DID) return;
        if ((await this.isFollowing(replyingToDID)) === false) return;
        if (Object.hasOwn(this._didDisplayNames, replyingToDID)) {
          const replyingToHandle = this._didDisplayNames[replyingToDID];
          text = `@${replyingToHandle} ${text}`;
        } else {
          const replyingToHandle = await this.getHandle(replyingToDID);
          text = `@${replyingToHandle} ${text}`;
        }
      }
      const url = `https://bsky.app/profile/${did}/post/${rkey}`;
      console.log(`Post: @${handle}: ${text}`);
      await ntfy(
        this.parseNotifyPayload({
          title: `@${handle}`,
          message: `${text}`,
          clickURL: url,
        }),
      );
    } catch (error) {}
  }
}
