import dotenv from "dotenv";

dotenv.config();

import Consumer from "./components/consumer.js";

const consumer = Consumer.shared();
