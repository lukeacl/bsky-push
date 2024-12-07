import { cborToLexRecord, readCar } from "@atproto/repo";
import { Subscription } from "@atproto/xrpc-server";
import EventEmitter from "events";

export default class Receiver extends EventEmitter {
  static shared() {
    if (!this._instance) {
      this._instance = new Receiver();
    }
    return this._instance;
  }

  constructor() {
    super();
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

  async start() {
    console.log("Subscribing...");
    try {
      this.emit("connected");
      for await (const event of this._subscription) {
        const [_, eventType] = event["$type"].split("#");

        if (event.time) event.time = new Date(event.time);

        const { time, seq } = event;

        const latency = (Date.now() - time.getTime()) / 1000;
        this.emit("latency", latency);

        switch (eventType) {
          case "commit":
            this.handleCommmit(event);
            break;
          case "tombstone":
            this.handleTombstone(event);
            break;
          case "account":
            this.handleAccount(event);
            break;
          case "identity":
            this.handleIdentity(event);
            break;
          case "handle":
            this.handleHandle(event);
            break;
          default:
            this.handleUnknown(event);
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
          const record = cborToLexRecord(recordBytes);
          this.emit(action, time, repo, collection, rkey, record);
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
