const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
require("dotenv").config();
const port = process.env.PORT;
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const {numberFormatter} = require("./helpers/formatter") 

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);

//return socket.io for ui when access url server
app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: __dirname,
  });
});

const sessions = [];
const FILE_OF_SESSIONS = "./.wa-session.json";
const SESSIONS_DIR = "./.wwebjs_auth/";

//check file session exist or not, if not will create file session
const createFileOfSessionWhenNotExist = function () {
  if (!fs.existsSync(FILE_OF_SESSIONS)) {
    try {
      fs.writeFileSync(FILE_OF_SESSIONS, JSON.stringify([]));
      console.log("create file of session succes");
    } catch (err) {
      console.log("failed create file of session: ", err);
    }
  }
};

//run check session file exist or not
createFileOfSessionWhenNotExist();

//add jession to file
const setFileOfSessions = function (sessions) {
  fs.writeFile(FILE_OF_SESSIONS, JSON.stringify(sessions), function (err) {
    if (err) {
      console.log(err);
    }
  });
};

//get file session
const getFileOfSessions = function () {
  return JSON.parse(fs.readFileSync(FILE_OF_SESSIONS));
};

//clean session folder who was not login
const cleanUpSessions = function () {
  const savedSessions = getFileOfSessions();
  const existingSessionIds = savedSessions.map((sess) => `session-${sess.id}`);

  // Baca direktori session
  fs.readdir(SESSIONS_DIR, (err, files) => {
    if (err) {
      console.error(`Unable to scan directory: ${err}`);
      return;
    }

    files.forEach((file) => {
      if (!existingSessionIds.includes(file)) {
        // Hapus folder yang tidak ada di session file
        fs.rm(
          path.join(SESSIONS_DIR, file),
          { recursive: true, force: true },
          (err) => {
            if (err) {
              console.error(
                `Error removing session directory ${file}: ${err.message}`
              );
            } else {
              console.log(`Session directory ${file} has been removed.`);
            }
          }
        );
      }
    });
  });
};

const createSession = function (id, description) {
  console.log("Creating session: " + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id,
    }),
  });

  client.initialize();

  //get qrCode and send to socket io, qrCode will be use to login whatsapp
  client.on("qr", (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      io.emit("qr", { id: id, src: url });
      io.emit("message", { id: id, text: "QR Code received, scan please!" });
    });
  });

  client.on("ready", () => {
    io.emit("ready", { id: id });
    io.emit("message", { id: id, text: "Whatsapp is ready!" });

    //save session when that ready
    const savedSessions = getFileOfSessions();
    const sessionIndex = savedSessions.findIndex(
      (thisSession) => thisSession.id == id
    );
    savedSessions[sessionIndex].ready = true;
    setFileOfSessions(savedSessions);
  });

  client.on("authenticated", () => {
    io.emit("authenticated", { id: id });
    io.emit("message", { id: id, text: "Whatsapp is authenticated!" });
  });

  client.on("auth_failure", function () {
    io.emit("message", { id: id, text: "Auth failure, restarting..." });
  });

  client.on("disconnected", (reason) => {
    io.emit("message", { id: id, text: "Whatsapp is disconnected!" });
    client.destroy();
    client.initialize();

    // Remove or deleted session at file sessions when session has been disconnected
    const savedSessions = getFileOfSessions();
    const sessionIndex = savedSessions.findIndex(
      (thisSession) => thisSession.id == id
    );
    savedSessions.splice(sessionIndex, 1);
    setFileOfSessions(savedSessions);

    io.emit("remove-session", id);
  });

  // Add client to sessions
  sessions.push({
    id: id,
    description: description,
    client: client,
  });

  // Add new session to file of session whatsapp
  const savedSessions = getFileOfSessions();
  const sessionIndex = savedSessions.findIndex(
    (thisSession) => thisSession.id == id
  );

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setFileOfSessions(savedSessions);
  }
  // Tambahkan listener untuk mendeteksi pesan !ping
  client.on("message", (msg) => {
    if (msg.body == "!bro") {
      msg.reply("okeyyyy");
    } else if (msg.body == "skuy") {
      msg.reply("helo ma bradah");
    }
  });
};

const init = function (socket) {
  const savedSessions = getFileOfSessions();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time we start or restart server, client has been saved is not ready!
       * Wait a minute until all of saved clied started
       * Set Ready to false so user not confused about server is ready or not yet
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit("init", savedSessions);
    } else {
      savedSessions.forEach((thisSession) => {
        createSession(thisSession.id, thisSession.description);
      });
    }
  }
  cleanUpSessions();
};

init();

// Socket IO: for UI server, we use to scan code dll
io.on("connection", function (socket) {
  init(socket);

  socket.on("create-session", function (data) {
    console.log("Create session: " + data.id);
    createSession(data.id, data.description);
  });
});

// Send message
app.post("/send-message", async (req, res) => {
  console.log(req);

  const sender = req.body.sender;
  const phoneNumber = numberFormatter(req.body.phoneNumber);
  const message = req.body.message;

  const client = sessions.find((sess) => sess.id == sender)?.client;

  // Check sender exist and active
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`,
    });
  }

  //check number is registered or not
  const isRegisteredNumber = await client.isRegisteredUser(phoneNumber);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: "Unregistered Number",
    });
  }

  client
    .sendMessage(phoneNumber, message)
    .then((response) => {
      res.status(200).json({
        status: true,
        response: response,
      });
    })
    .catch((err) => {
      res.status(500).json({
        status: false,
        response: err,
      });
    });
});

server.listen(port, function () {
  console.log(
    "App running on *: " + port + " (please open it to login whatsapp api)"
  );
});
