require("dotenv").config();

const express = require("express");
const morgan = require("morgan");

const app = express();
const requestId = require("./utils/requestId");
const chatRoutes = require("./openAI/chat");
const textRoutes = require("./openAI/text");
const imgRoutes = require("./openAI/image");
const embeddingRoutes = require("./openAI/embeddings");
const modelRoutes = require("./openAI/models");
const moderationRoutes = require("./openAI/moderation");
const audioRoutes = require("./openAI/audio");
const fineTuningRoutes = require("./openAI/fineTuning");
const batchRoutes = require("./openAI/batch");
const filesRoutes = require("./openAI/files");
const uploadsRoutes = require("./openAI/uploads");
const { load: loadRandomContents } = require("./utils/randomContents");
const delay = require("./utils/delay");
const {
  register,
  requestCounter,
  requestLatency,
  payloadSize,
} = require("./utils/metrics");

const BURST = process.env.RATE_LIMIT_BURST
  ? parseInt(process.env.RATE_LIMIT_BURST)
  : null;
const RATE = process.env.RATE_LIMIT_RPM
  ? parseInt(process.env.RATE_LIMIT_RPM)
  : null;

const buckets = new Map();

function rateLimit(req, res, next) {
  // Disable if either BURST or RATE is not set
  if (BURST === null || RATE === null) {
    return next();
  }

  if (!req.body || !req.body.model) {
    return next();
  }

  // Use req.body.model as the bucket key
  const key = req.body.model;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: BURST, last: now };
    buckets.set(key, bucket);
  }

  const elapsed = (now - bucket.last) / 60000;

  // Calculate the replenished tokens since the last request
  bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * RATE);
  bucket.last = now;

  if (bucket.tokens >= 1) {
    // Enough tokens available, deduct one token and proceed
    bucket.tokens -= 1;
    next();
  } else {
    res.status(429).json({ error: "Too Many Requests" });
  }
}

const setupApp = async () => {
  await loadRandomContents();

  const req_limit = process.env.REQUEST_SIZE_LIMIT || "10kb";
  app.use(express.json({ limit: req_limit }));

  app.use(rateLimit);

  // Request Logger Configuration
  app.use(requestId);
  morgan.token("id", function getId(req) {
    return req.id;
  });
  const loggerFormat =
    ':id [:date[web]]" :method :url" :status :response-time ms';

  app.use(
    morgan(loggerFormat, {
      skip: function (req, res) {
        return res.statusCode < 400;
      },
      stream: process.stderr,
    })
  );
  app.use(
    morgan(loggerFormat, {
      skip: function (req, res) {
        return res.statusCode >= 400;
      },
      stream: process.stderr,
    })
  );

  app.use(chatRoutes);
  app.use(textRoutes);
  app.use(imgRoutes);
  app.use(embeddingRoutes);
  app.use(modelRoutes);
  app.use(moderationRoutes);
  app.use(audioRoutes);
  app.use(fineTuningRoutes);
  app.use(batchRoutes);
  app.use(filesRoutes);
  app.use(uploadsRoutes);

  app.get("/", async (req, res) => {
    const then = Date.now();
    const delayHeader = req.headers["x-set-response-delay-ms"];

    let delayTime =
      parseInt(delayHeader) || parseInt(process.env.RESPONSE_DELAY_MS) || 0;

    await delay(delayTime);

    requestCounter.inc({ method: "GET", path: "/", status: res.statusCode });
    requestLatency.observe(
      { method: "GET", path: "/", status: 200 },
      Date.now() - then
    );
    payloadSize.observe(
      { method: "GET", path: "/", status: 200 },
      req.socket.bytesRead
    );
    res.send("Hello World! This is MockAI");
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  app.use(function (req, res) {
    const then = Date.now();
    requestCounter.inc({ method: req.method, path: req.path, status: 404 });
    requestLatency.observe(
      { method: req.method, path: req.path, status: 404 },
      Date.now() - then
    );
    payloadSize.observe(
      { method: req.method, path: req.path, status: 404 },
      req.socket.bytesRead
    );
    res.status(404).send("Page not found");
  });

  return app;
};

const startServer = async () => {
  await setupApp();
  const port = process.env.SERVER_PORT || 5001;
  app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
};

// Export both the app and the setup function
module.exports = { app, setupApp };

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}
