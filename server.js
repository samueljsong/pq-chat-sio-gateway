import http from "http";
import { Server } from "socket.io";
import net from "net";

// Configurations
const SIO_PORT = 3001; // Socket.IO gateway port
const TCP_HOST = "127.0.0.1";
const TCP_PORT = 9001;
const ALLOWED_ORIGIN = "http://localhost:5173";

// TCP framing helpers (4-byte big-endian length prefix)
function writeFrame(socket, obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
}

function createFrameReader(onFrame) {
    let buf = Buffer.alloc(0);

    return (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        while (buf.length >= 4) {
        const len = buf.readInt32BE(0);
        if (len < 0 || len > 10_000_000) throw new Error("Bad frame length: " + len);
        if (buf.length < 4 + len) return;

        const payload = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);

        onFrame(payload);
        }
    };
}

// Create HTTP + Socket.IO server
const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("pq-chat-sio-gateway ok");
});

const io = new Server(httpServer, {
    cors: {
        origin: ALLOWED_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true,
    },
    transports: ["websocket"],
});

io.on("connection", (socket) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
        socket.emit("server_msg", { type: "ERROR", message: "Missing token" });
        socket.disconnect(true);
        return;
    }

    console.log(`[SIO] connected socket=${socket.id}`);

    const tcp = new net.Socket();
    let tcpConnected = false;

    const feed = createFrameReader((payload) => {
        const json = payload.toString("utf8");

        console.log(`[TCP -> SIO ${socket.id}] ${json}`);

        let msg;
        try {
            msg = JSON.parse(json);
        } catch {
            console.log(`[SIO] bad TCP json for ${socket.id}:`, json);
            return;
        }

        socket.emit("server_msg", msg);
    });

    tcp.on("data", (chunk) => {
        try {
            feed(chunk);
        } catch (e) {
            console.log(`[SIO] TCP frame parse error (${socket.id}):`, e.message);
            socket.emit("server_msg", { type: "ERROR", message: "TCP parse error" });
            socket.disconnect(true);
            tcp.destroy();
        }
    });

    tcp.on("close", () => {
        console.log(`[SIO] TCP closed -> disconnect socket=${socket.id}`);
        tcpConnected = false;
        if (socket.connected) socket.disconnect(true);
    });

    tcp.on("error", (err) => {
        console.log(`[SIO] TCP error (${socket.id}):`, err.message);
        socket.emit("server_msg", { type: "ERROR", message: "TCP connect error: " + err.message });
        socket.disconnect(true);
    });

    // connect TCP and AUTH
    tcp.connect(TCP_PORT, TCP_HOST, () => {
        tcpConnected = true;
        console.log(`[SIO] TCP connected ${TCP_HOST}:${TCP_PORT} for socket=${socket.id}`);

        // IMPORTANT: your TCP server expects capitalized fields: Type, Token
        console.log(`[SIO] ${socket.id} -> TCP AUTH`);
        writeFrame(tcp, { Type: "AUTH", Token: token });

        socket.emit("server_msg", { type: "GATEWAY_READY" });
    });

    // client -> gateway -> TCP
    socket.on("join_conversation", (payload) => {
        const conversationId = payload?.conversationId;
        console.log(`[SIO] ${socket.id} JOIN ->`, conversationId);

        if (!tcpConnected) return;

        if (!conversationId) {
            socket.emit("server_msg", { type: "ERROR", message: "Missing conversationId (client)" });
            return;
        }

        writeFrame(tcp, {
            Type: "JOIN_CONVERSATION",
            ConversationId: conversationId,
        });
    });

    socket.on("send_message", (payload) => {
        const conversationId = payload?.conversationId;
        const ciphertext = payload?.ciphertext;
        console.log(`[SIO] ${socket.id} SEND ->`, conversationId, ciphertext);

        if (!tcpConnected) return;

        if (!conversationId) {
        socket.emit("server_msg", { type: "ERROR", message: "Missing conversationId (client)" });
        return;
        }

        writeFrame(tcp, {
            Type: "SEND_MESSAGE",
            ConversationId: conversationId,
            Ciphertext: ciphertext ?? "",
        });
    });

    socket.on("disconnect", (reason) => {
        console.log(`[SIO] disconnected socket=${socket.id} reason=${reason}`);
        try { tcp.end(); } catch {}
        try { tcp.destroy(); } catch {}
    });
});

httpServer.listen(SIO_PORT, () => {
    console.log(`Socket.IO gateway listening on http://localhost:${SIO_PORT}`);
});
