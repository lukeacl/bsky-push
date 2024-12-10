import { cborToLexRecord, readCar } from "@atproto/repo";
import { Subscription } from "@atproto/xrpc-server";
import EventEmitter from "events";
import { performance } from "node:perf_hooks";

export default class Receiver extends EventEmitter {
  static shared() {
    if (!this._instance) {
      this._instance = new Receiver();
    }
    return this._instance;
  }

  constructor() {
    super();
    this._filterRepos = undefined;
    this._subscription = new Subscription({
      service: "https://bsky.network",
      method: "com.atproto.sync.subscribeRepos",
      getParams: () => {
        let params = {};
        return params;
      },
      validate: (value) => {
        try {
          return value;
        } catch (error) {
          console.log(error.message);
        }
      },
    });
  }

  filterRepos(repos) {
    this._filterRepos = repos;
    console.log(
      `Filtering ${repos.length} repo${repos.length === 1 ? "" : "s"}`,
    );
  }

  async start() {
    console.log("Subscribing...");
    try {
      this.emit("connected");
      for await (const event of this._subscription) {
        const [_, eventType] = event["$type"].split("#");

        if (event.time) event.time = new Date(event.time);

        const { repo, time, seq } = event;

        const latency = (Date.now() - time.getTime()) / 1000;
        this.emit("latency", latency);

        if (this._filterRepos !== undefined) {
          if (this._filterRepos.includes(repo) === false) continue;
        }

        switch (eventType) {
          case "commit":
            await this.handleCommmit(event);
            break;
          case "tombstone":
            await this.handleTombstone(event);
            break;
          case "account":
            await this.handleAccount(event);
            break;
          case "identity":
            await this.handleIdentity(event);
            break;
          case "handle":
            await this.handleHandle(event);
            break;
          default:
            await this.handleUnknown(event);
            break;
        }
      }
    } catch (error) {
      if (error.error === "ConsumerTooSlow") {
        console.log("We're too slow. Disconnected.");
        this.emit("disconnectedSlow");
        setTimeout(() => {
          this.subscribe();
        }, 1000);
      } else {
        console.log(error);
        this.emit("disconnected", error);
        setTimeout(() => {
          this.subscribe();
        }, 1000 * 60000);
      }
    }
  }

  async handleCommmit(event) {
    let { time, repo, ops, blocks, blobs } = event;
    const car = await readCar(blocks);
    for (const op of ops) {
      const { cid, action, path } = op;
      const [collection, rkey] = path.split("/");
      const uri = `at://${repo}/${collection}/${rkey}`;
      if (action === "create" || action === "update") {
        if (cid !== null) {
          const recordBytes = car.blocks.get(cid);
          try {
            const record = cborToLexRecord(recordBytes);
            this.emit(action, time, repo, collection, rkey, record);
          } catch (error) {}
        }
      } else if (action === "delete") {
        this.emit(action, time, repo, collection, rkey);
      }
    }
  }

  async handleTombstone(event) {
    let { time, did } = event;
  }

  async handleAccount(event) {
    let { time, did, active, status } = event;
  }

  async handleIdentity(event) {
    let { time, did, handle } = event;
  }

  async handleHandle(event) {
    let { time, did, handle } = event;
  }

  async handleUnknown(event) {
    console.log(event);
  }
}
