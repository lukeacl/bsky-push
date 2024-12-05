import dotenv from "dotenv";
import { Jetstream } from "@skyware/jetstream";
import WebSocket from "ws";
import Pushover from "pushover-notifications";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import path from "path";
import { AtpAgent } from "@atproto/api";
import { publish } from "ntfy";
import ntfyPublish from "@cityssm/ntfy-publish";

dotenv.config();

const agent = new AtpAgent({ service: "https://public.api.bsky.app" });

const push = new Pushover({
  user: process.env.PUSHOVER_USER,
  token: process.env.PUSHOVER_APP,
});

const notify = async (payload) => {
  if (process.env.PUSHOVER_ENABLED == "1") push.send(payload);
  if (process.env.NTFY_ENABLED == "1") {
    const ntfyPayload = {
      ...(process.env.NTFY_BASE_URL
        ? { server: process.env.NTFY_BASE_URL }
        : {}),
      topic: process.env.NTFY_TOPIC,
      title: payload.title,
      message: payload.message,
      ...(payload.url ? { clickURL: payload.url } : {}),
    };
    await ntfyPublish(ntfyPayload);
  }
};

let wantedDids = {};
let profiles = {};
let posts = {};

(async () => {
  const getWantedDids = async () => {
    const list = await (
      await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.graph.getList?list=${process.env.LIST_URI}`,
      )
    ).json();

    wantedDids = list.items.reduce((prev, curr) => {
      const uriSplit = curr.uri.split("/");
      const rkey = uriSplit[4];
      const did = curr.subject.did;
      prev[rkey] = did;
      return prev;
    }, {});

    console.log(
      `Watching ${Object.keys(wantedDids).length} account${Object.keys(wantedDids).length === 1 ? "" : "s"}!`,
    );
  };

  await getWantedDids();

  notify({
    title: "Started",
    message: `Watching ${Object.keys(wantedDids).length} account${Object.keys(wantedDids).length === 1 ? "" : "s"}!`,
    url: process.env.LIST_URI.replace(
      "at://",
      "https://bsky.app/profile/",
    ).replace("app.bsky.graph.list", "lists"),
  });

  const getJetstreamOptions = () => {
    const options = {
      wantedCollections: [
        "app.bsky.graph.list",
        "app.bsky.graph.listitem",
        "app.bsky.feed.post",
      ],
      /*wantedDids: [
        process.env.MY_DID,
        ...Object.keys(wantedDids).reduce(
          (prev, curr) => [...prev, wantedDids[curr]],
          [],
        ),
        ],*/
    };
    return options;
  };

  const jetstream = new Jetstream({
    ws: WebSocket,
    ...getJetstreamOptions(),
  });

  const updateJetstreamOptions = () => {
    const options = getJetstreamOptions();
    jetstream.ws.send(
      JSON.stringify({
        type: "options_update",
        payload: {
          ...getJetstreamOptions(),
        },
      }),
    );
  };

  const ensureProfile = async (did, force = false) => {
    if (Object.hasOwn(profiles, did) === false || force === true) {
      profiles[did] = await (
        await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${did}`,
        )
      ).json();
    }
  };

  const ensurePosts = async (uris, force = false) => {
    let postsToGet = [];
    for (const uri of uris) {
      if (Object.hasOwn(posts, uri) === false || force === true) {
        postsToGet.push(uri);
      }
    }
    if (postsToGet.length > 0) {
      const response = await agent.getPosts({
        uris: postsToGet,
      });
      for (const newPost of response.data.posts) {
        posts[newPost.uri] = newPost;
      }
    }
  };

  jetstream.onCreate("app.bsky.graph.listitem", async (event) => {
    const did = event.commit.record.subject;
    const uri = event.commit.record.list;

    if (did == process.env.MY_DID) return;
    if (uri !== process.env.LIST_URI) return;

    await ensureProfile(did, true);
    const profile = profiles[event.commit.record.subject];

    let pushPayload = {
      title: `Watching (${Object.keys(wantedDids).length})`,
      message: profile.handle,
      url: `https://bsky.app/profile/${profile.handle}`,
    };

    if (process.env.INCLUDE_AVATARS == "1") {
      try {
        const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
        const avatarTempFile = path.join(
          os.tmpdir(),
          "bsky.avatar." + crypto.randomBytes(16).toString("hex"),
        );
        fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
        pushPayload.file = avatarTempFile;
      } catch (error) {}
    }

    notify(pushPayload);

    console.log(`Watching ${profile.handle}!`);

    wantedDids[event.commit.rkey] = event.commit.record.subject;

    //updateJetstreamOptions();
  });

  jetstream.onDelete("app.bsky.graph.listitem", async (event) => {
    const rkey = event.commit.rkey;
    const did = wantedDids[rkey];

    if (did == process.env.MY_DID) return;
    if (!Object.keys(wantedDids).includes(rkey)) return;

    await ensureProfile(did);
    const profile = profiles[did];

    let pushPayload = {
      title: `Unwatching (${Object.keys(wantedDids).length})`,
      message: profile.handle,
      url: `https://bsky.app/profile/${profile.handle}`,
    };

    if (process.env.INCLUDE_AVATARS == "1") {
      try {
        const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
        const avatarTempFile = path.join(
          os.tmpdir(),
          "bsky.avatar." + crypto.randomBytes(16).toString("hex"),
        );
        fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
        pushPayload.file = avatarTempFile;
      } catch (error) {}
    }

    notify(pushPayload);

    console.log(`Unwatching ${profile.handle}!`);

    delete wantedDids[event.commit.rkey];

    //updateJetstreamOptions();
  });

  jetstream.onCreate("app.bsky.feed.post", async (event) => {
    const rkey = event.commit.rkey;
    const did = event.did;

    if (did == process.env.MY_DID) return;

    const postURL = `https://bsky.app/profile/${did}/post/${rkey}`;

    const post = event.commit.record;

    await ensureProfile(did);
    const profile = profiles[did];

    let pushPayload = {
      title: profile.handle,
      message: post.text == "" ? "<blank>" : post.text,
      url: postURL,
    };

    if (post.reply) {
      if (process.env.INCLUDE_REPLIES != "1") return;

      const rootURI = post.reply.root.uri;
      const parentURI = post.reply.parent.uri;
      const uris = [rootURI, parentURI];

      await ensurePosts(uris);

      if (Object.hasOwn(posts, parentURI)) {
        const parentPost = posts[parentURI];

        if (parentPost.author.did == process.env.MY_DID) return;

        const response = await agent.app.bsky.graph.getRelationships({
          actor: process.env.MY_DID,
          others: [parentPost.author.did],
        });
        const relationships = response.data.relationships;

        if (relationships[0].following === undefined) return;

        pushPayload.message = `@${parentPost.author.handle} ${pushPayload.message}`;
      }
    }

    if (process.env.INCLUDE_AVATARS == "1") {
      try {
        const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
        const avatarTempFile = path.join(
          os.tmpdir(),
          "bsky.avatar." + crypto.randomBytes(16).toString("hex"),
        );
        fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
        pushPayload.file = avatarTempFile;
      } catch (error) {}
    }

    notify(pushPayload);
    console.log(`${pushPayload.title}: ${pushPayload.message}`);
  });

  jetstream.start();
})();
