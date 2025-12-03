const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const mysql = require("mysql2/promise");

const PORT = 4000;

async function createDbPool() {
  const pool = mysql.createPool({
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "your_password",
    database: "auction_demo",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  return pool;
}

async function ensureSchema(pool) {
  // 确保表存在（如果完全按 README 已经建好，可以不执行这里，但为了 demo 自包含，这里做一次保障）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auctions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      current_price DECIMAL(10,2) NOT NULL DEFAULT 0,
      status ENUM('pending', 'running', 'ended') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM auctions");
  if (rows[0].cnt === 0) {
    const now = new Date();
    const start = new Date(now.getTime() - 1 * 60 * 1000); // 提前 1 分钟开始
    const end = new Date(now.getTime() + 5 * 60 * 1000); // 5 分钟后结束
    await pool.query(
      "INSERT INTO auctions (name, start_time, end_time, current_price, status) VALUES (?, ?, ?, ?, ?)",
      [
        "示例测试拍卖（自动生成）",
        formatDateTime(start),
        formatDateTime(end),
        100.0,
        "running",
      ]
    );
    console.log("已自动插入一条测试拍卖数据。");
  }
}

function formatDateTime(d) {
  const pad = (n) => (n < 10 ? "0" + n : n);
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

async function main() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // 简单的“房间”管理：auctionId -> Set<ws>
  const rooms = new Map();

  function joinRoom(ws, auctionId) {
    const id = Number(auctionId);
    if (!id) return;
    if (!rooms.has(id)) {
      rooms.set(id, new Set());
    }
    rooms.get(id).add(ws);
    ws._auctionId = id;
  }

  function leaveRoom(ws) {
    const id = ws._auctionId;
    if (!id) return;
    const set = rooms.get(id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        rooms.delete(id);
      }
    }
    ws._auctionId = null;
  }

  function broadcastToAuction(auctionId, payload) {
    const id = Number(auctionId);
    if (!id) return;
    const set = rooms.get(id);
    if (!set) return;
    const msg = JSON.stringify(payload);
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  app.use(cors());
  app.use(express.json());

  const pool = await createDbPool();
  await ensureSchema(pool);

  // 简单日志
  app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  // 获取所有拍卖
  app.get("/api/auctions", async (req, res) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, name, start_time, end_time, current_price, status FROM auctions ORDER BY id ASC"
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "获取拍卖列表失败" });
    }
  });

  // NTP 时间同步接口（用于计算客户端时间偏移量）
  app.post("/api/time-sync", async (req, res) => {
    const { clientTime } = req.body || {};
    if (typeof clientTime !== "number" && typeof clientTime !== "string") {
      return res.status(400).json({ message: "请提供 clientTime" });
    }
    const serverTime = Date.now();
    res.json({
      serverTime,
      clientTime:
        typeof clientTime === "number"
          ? clientTime
          : new Date(clientTime).getTime(),
    });
  });

  // 获取单个拍卖详情 + 当前服务端时间
  app.get("/api/auctions/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "无效的拍卖 ID" });
    }
    try {
      const [rows] = await pool.query(
        "SELECT id, name, start_time, end_time, current_price, status FROM auctions WHERE id = ? LIMIT 1",
        [id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ message: "拍卖不存在" });
      }
      res.json({
        auction: rows[0],
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "获取拍卖详情失败" });
    }
  });

  // 出价接口
  app.post("/api/auctions/:id/bid", async (req, res) => {
    const id = Number(req.params.id);
    const { amount, userId } = req.body || {};
    if (!id || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "参数错误或金额无效" });
    }
    const now = new Date();
    try {
      const [rows] = await pool.query(
        "SELECT * FROM auctions WHERE id = ? LIMIT 1",
        [id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ message: "拍卖不存在" });
      }
      const auction = rows[0];
      const startTime = new Date(auction.start_time);
      const endTime = new Date(auction.end_time);

      if (now < startTime) {
        return res.status(400).json({ message: "拍卖尚未开始" });
      }
      if (now > endTime || auction.status === "ended") {
        return res.status(400).json({ message: "拍卖已结束" });
      }
      const currentPrice = Number(auction.current_price);
      if (amount <= currentPrice) {
        return res.status(400).json({ message: "出价必须高于当前价格" });
      }

      // 更新价格
      await pool.query(
        "UPDATE auctions SET current_price = ?, status = ? WHERE id = ?",
        [amount, "running", id]
      );

      const payload = {
        type: "bidUpdate",
        data: {
          auctionId: id,
          newPrice: amount,
          userId: userId || "anonymous",
          serverTime: new Date().toISOString(),
        },
      };

      // 广播给房间内所有客户端（对应之前的 auction-{id} 房间）
      broadcastToAuction(id, payload);

      res.json({
        message: "出价成功",
        ...payload,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "出价失败" });
    }
  });

  // WebSocket 逻辑（原生协议，事件封装自己处理）
  wss.on("connection", (ws, req) => {
    console.log("[WS] 客户端已连接:", req.socket.remoteAddress);

    ws.on("message", async (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        console.error("收到非 JSON 消息，已忽略:", message.toString());
        return;
      }

      const { type, payload } = data || {};

      // 客户端请求加入某个拍卖“房间”
      if (type === "joinAuction") {
        const { auctionId } = payload || {};
        const id = Number(auctionId);
        if (!id) return;

        joinRoom(ws, id);
        console.log(`[WS] 连接加入拍卖房间 auction-${id}`);

        // 初次加入时，发送当前拍卖数据 + 服务端时间
        try {
          const [rows] = await pool.query(
            "SELECT id, name, start_time, end_time, current_price, status FROM auctions WHERE id = ? LIMIT 1",
            [id]
          );
          if (rows.length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "auctionData",
                data: {
                  auction: rows[0],
                  serverTime: new Date().toISOString(),
                },
              })
            );
          }
        } catch (err) {
          console.error(err);
        }
      }
    });

    ws.on("close", () => {
      leaveRoom(ws);
      console.log("[WS] 客户端断开连接");
    });
  });

  // 后台任务：每秒检查是否有已到结束时间但还没标记为 ended 的拍卖
  setInterval(async () => {
    try {
      const now = new Date();
      const nowStr = formatDateTime(now);
      const [rows] = await pool.query(
        "SELECT * FROM auctions WHERE status != 'ended' AND end_time <= ?",
        [nowStr]
      );
      if (rows.length > 0) {
        for (const auction of rows) {
          await pool.query("UPDATE auctions SET status = ? WHERE id = ?", [
            "ended",
            auction.id,
          ]);
          broadcastToAuction(auction.id, {
            type: "auctionEnded",
            data: {
              auctionId: auction.id,
              serverTime: new Date().toISOString(),
            },
          });
          console.log(`拍卖 ${auction.id} 已结束，已广播给相关房间。`);
        }
      }
    } catch (err) {
      console.error("检查拍卖结束状态失败:", err);
    }
  }, 1000);

  server.listen(PORT, () => {
    console.log(`HTTP & WS server is running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("服务启动失败:", err);
  process.exit(1);
});
