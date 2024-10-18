import dotenv from "dotenv";
import { Jetstream } from "@skyware/jetstream";
import WebSocket from "ws";
import Pushover from "pushover-notifications";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import path from "path";
import { AtpAgent } from "@atproto/api";

dotenv.config();

const agent = new AtpAgent({ service: "https://public.api.bsky.app" })

const push = new Pushover({
    user: process.env.PUSHOVER_USER,
    token: process.env.PUSHOVER_APP
});

let wantedDids = {};
let profiles = {};
let posts = {};

(async () => {
    
    const getWantedDids = async () => {
        const list = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.graph.getList?list=${process.env.LIST_URI}`)).json();

        wantedDids = list.items.reduce((prev, curr) => {
            const uriSplit = curr.uri.split("/");
            const rkey = uriSplit[4];
            const did = curr.subject.did;
            prev[rkey] = did;
            return prev;
        }, {});

        console.log(`Watching ${Object.keys(wantedDids).length} account${Object.keys(wantedDids).length === 1 ? "" : "s"}!`);
    };

    await getWantedDids();

    push.send({
        title: "Started",
        message: `Watching ${Object.keys(wantedDids).length} account${Object.keys(wantedDids).length === 1 ? "" : "s"}!`
    });

    const getJetstreamOptions = () => {
        return {
            wantedCollections: ["app.bsky.graph.list", "app.bsky.graph.listitem", "app.bsky.feed.post"],
            wantedDids: [process.env.MY_DID, ...Object.keys(wantedDids).reduce((prev, curr) => [...prev, wantedDids[curr]], [])]
        }
    };

    const jetstream = new Jetstream({
        ws: WebSocket,
        ...getJetstreamOptions(),
    });

    const updateJetstreamOptions = () => {
        const options = getJetstreamOptions();
        jetstream.ws.send(JSON.stringify({
            "type": "options_update",
                "payload": {
                    ...getJetstreamOptions()
                }
        }));
    };

    const ensureProfile = async (did, force = false) => {
        if (Object.hasOwn(profiles, did) === false || force === true) {
            profiles[did] = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${did}`)).json();
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
                uris: postsToGet
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
            title: "Watching",
            message: profile.handle
        };

        try {
            const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
            const avatarTempFile = path.join(os.tmpdir(), "bsky.avatar." + crypto.randomBytes(16).toString("hex"));
            fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
            pushPayload.file = avatarTempFile;
        } catch (error) { }

        push.send(pushPayload);

        console.log(`Watching ${profile.handle}!`);

        wantedDids[event.commit.rkey] = event.commit.record.subject;

        updateJetstreamOptions();
    });
    
    jetstream.onDelete("app.bsky.graph.listitem", async (event) => {
        const rkey = event.commit.rkey;
        const did = wantedDids[rkey];

        if (did == process.env.MY_DID) return;
        if (!Object.keys(wantedDids).includes(rkey)) return;

        await ensureProfile(did);
        const profile = profiles[did];

        let pushPayload = {
            title: "Unwatching",
            message: profile.handle
        };

        try {
            const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
            const avatarTempFile = path.join(os.tmpdir(), "bsky.avatar." + crypto.randomBytes(16).toString("hex"));
            fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
            pushPayload.file = avatarTempFile;
        } catch (error) { }

        push.send(pushPayload);

        console.log(`Unwatching ${profile.handle}!`);

        delete wantedDids[event.commit.rkey];

        updateJetstreamOptions();
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
            url: postURL
        };

        if (post.reply) {
            const rootURI = post.reply.root.uri;
            const parentURI = post.reply.parent.uri;
            const uris = [rootURI, parentURI];

            await ensurePosts(uris);

            if (Object.hasOwn(posts, parentURI)) {
                const parentPost = posts[parentURI];

                if (parentPost.author.did == process.env.MY_DID) return;

                const response = await agent.app.bsky.graph.getRelationships({ actor: process.env.MY_DID, others: [parentPost.author.did] });
                const relationships = response.data.relationships;

                if (relationships[0].following === undefined) return;
                
                pushPayload.message = `@${parentPost.author.handle} ${pushPayload.message}`;
            }

        }

        try {
            const avatarData = await (await fetch(profile.avatar)).arrayBuffer();
            const avatarTempFile = path.join(os.tmpdir(), "bsky.avatar." + crypto.randomBytes(16).toString("hex"));
            fs.writeFileSync(avatarTempFile, new Uint8Array(avatarData));
            pushPayload.file = avatarTempFile;
        } catch (error) { }

        push.send(pushPayload);
        console.log(`${pushPayload.title}: ${pushPayload.message}`);
    });
    
    jetstream.on("account", (event) => {
        console.log(event);
    });

    jetstream.start();

})();