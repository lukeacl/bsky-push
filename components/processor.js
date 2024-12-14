import { AtpAgent, AppBskyGraphListitem } from "@atproto/api";
import ntfy from "@cityssm/ntfy-publish";
import EventEmitter from "events";

import Logger from "./logger.js";
import JetstreamClient from "./jetstreamClient.js";

export default class Processor extends EventEmitter {
  static shared() {
    if (!this._instance) {
      this._instance = new Processor();
    }
    return this._instance;
  }

  constructor() {
    super();
    this._latencySamples = [];
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
    const client = JetstreamClient.shared();
    client.filterCollections(["app.bsky.graph.listitem", "app.bsky.feed.post"]);
    const updateFilterRepos = () => {
      client.filterRepos([...this._wantedDIDs, process.env.MY_DID]);
    };
    updateFilterRepos();
    client.on("commit", async (data) => {
      try {
        const { did, commit } = data;
        const { operation, collection, rkey } = commit;

        if (operation === "create") {
          const { record } = commit;

          if (collection === "app.bsky.graph.listitem") {
            if (did === process.env.MY_DID) {
              const { list, subject: did } = record;
              if (list === process.env.LIST_URI) {
                await this.watch(did, rkey);
                updateFilterRepos();
              }
            }
          }

          if (collection === "app.bsky.feed.post") {
            if (this._wantedDIDs.includes(did)) {
              this.handlePost(did, rkey, record);
            }
          }
        }

        if (operation === "delete") {
          if (collection === "app.bsky.graph.listitem") {
            if (did === process.env.MY_DID) {
              await this.unwatch(rkey);
              updateFilterRepos();
            }
          }
        }
      } catch (error) {
        Logger.shared().info(`${error}`);
      }
    });
    client.start();
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
    Logger.shared().info(`Fetching wanted repos...`);
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
    Logger.shared().info(`Watching: ${this._wantedDIDs.length}`);
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
      Logger.shared().info(
        `Watch: ${did}, ${handle}, ${this._wantedDIDs.length}`,
      );
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
      Logger.shared().info(
        `Unwatch: ${did}, ${handle}, ${this._wantedDIDs.length}`,
      );
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
        if (Object.hasOwn(this._didHandles, replyingToDID)) {
          const replyingToHandle = this._didHandles[replyingToDID];
          text = `@${replyingToHandle} ${text}`;
        } else {
          const replyingToHandle = await this.getHandle(replyingToDID);
          text = `@${replyingToHandle} ${text}`;
        }
      }
      const url = `https://bsky.app/profile/${did}/post/${rkey}`;
      Logger.shared().info(`Post: @${handle}: ${text}`);
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
