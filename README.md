## 倒计时多端同步竞价示例（React + Node.js + MySQL）

本项目是一个**简单可跑的 demo**，演示如何实现「竞价 / 秒杀倒计时多端同步」：

- **后端**：Node.js + Express + Socket.io + MySQL（`mysql2`）
- **前端**：React + Vite + Socket.io Client
- **前端**：推进使用 v20.0.0 版本，支持 React 18

功能特点（简化版）：

- **统一以服务端时间为准**，避免多端本地时间不一致
- **倒计时多端同步**：任意一端刷新 / 打开，倒计时一致
- **竞价多端同步**：一端出价，所有已连入的终端实时看到最新价格与剩余时间
- **NTP 时间校准**：首次连接时计算本地时间偏移量，定期重新校准，确保时间准确性
- **requestAnimationFrame 倒计时**：使用 RAF 替代 setInterval，避免掉帧导致的累积误差

---

### 一、数据库准备（MySQL）

在你的 MySQL 中执行以下 SQL，新建一个数据库和一张简单的 `auctions` 表：

```sql
CREATE DATABASE IF NOT EXISTS auction_demo
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE auction_demo;

CREATE TABLE IF NOT EXISTS auctions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  current_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  status ENUM('pending', 'running', 'ended') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

> 后端第一次启动时，如果表中没有任何数据，会自动插入一条「测试拍卖」数据，方便本地直接体验。

---

### 二、后端项目（`server`）

目录：`server`

主要技术栈：

- `express`：HTTP API
- `ws`：WebSocket 实时通信
- `mysql2`：连接 MySQL
- `cors`：跨域


#### 2. 安装依赖 & 启动

```bash
cd server
npm install
npm run dev
```

默认会启动在 `http://localhost:4000`。

主要接口：

- `GET /api/auctions`：获取所有拍卖简要信息
- `GET /api/auctions/:id`：获取单个拍卖详情 + 当前服务端时间
- `POST /api/auctions/:id/bid`：提交出价（校验时间与价格）
- `POST /api/time-sync`：NTP 时间同步接口，用于计算客户端时间偏移量

主要 Socket.io 事件：

- 客户端发送 `joinAuction`（带上 `auctionId`）后加入对应房间
- 服务端广播：
  - `auctionData`：当前拍卖信息 + 服务端时间
  - `bidUpdate`：最新出价信息
  - `auctionEnded`：拍卖结束通知

---

### 三、前端项目（`client`）

目录：`client`

主要技术栈：

- `React`
- `Vite`
- `socket.io-client`

#### 1. 安装依赖 & 启动

```bash
cd client
npm install
npm run dev
```

默认访问地址类似：`http://localhost:5173`（具体以 Vite 控制台输出为准）。

#### 2. 主要页面说明

当前 demo 只有一个主要页面：

- 页面加载后：
  - 调用 `GET /api/auctions` 获取列表（示例中直接取第一条拍卖）
  - 调用 `GET /api/auctions/:id` 获取拍卖详情和**服务端当前时间**
  - 根据 `end_time` 与 `serverTime` 计算剩余倒计时
  - 建立 Socket.io 连接，发送 `joinAuction` 加入房间
- 倒计时逻辑：
  - 使用「`endTime - serverNow`」计算剩余时间，而不是本地时间
  - **使用 `requestAnimationFrame` 替代 `setInterval`**：避免掉帧导致的累积误差，每次渲染时计算真实经过的时间差
  - **NTP 时间校准**：
    - 首次连接时调用 `/api/time-sync` 接口，计算本地时间偏移量 `offset = serverTime - clientTime`
    - 后续用 `Date.now() + offset` 来模拟服务端时间
    - 每 30 秒重新校准一次，确保长时间运行后时间仍然准确
  - 如果收到服务端推送的数据，会用服务端时间再做一次「校准」
- 出价逻辑：
  - 输入出价金额，点击「出价」
  - 前端通过 `POST /api/auctions/:id/bid` 调用后端
  - 出价成功后，服务端会广播 `bidUpdate`，所有在线终端同步更新价格与剩余时间

---

### 四、运行顺序建议

1. **先启动 MySQL** 并确认数据库与表已经创建好
2. 在 `server` 目录：
   - `npm install`
   - `npm run dev`
3. 在 `client` 目录：
   - `npm install`
   - `npm run dev`
4. 打开两个浏览器窗口（或 PC+手机），访问前端地址，观察：
   - 倒计时是否一致
   - 其中一端出价，另一端是否实时同步

---

### 五、组内分享时可重点讲解的点

- **为什么要以服务端时间为准**：本地时间可能被用户或系统修改，导致倒计时不可信
- **如何做多端倒计时同步**：
  - 后端统一给出「结束时间 `end_time` + 当前服务端时间 `serverTime`」
  - 前端只保存「剩余毫秒数」，用本地计时器递减
  - 若中途刷新页面，只要重新从服务端获取一次，就能重新对齐
- **如何用 WebSocket 实现多端竞价同步**：
  - 一拍卖一个房间（`auction-{id}`），只推送给相关用户
  - 每次出价成功后广播 `bidUpdate`
  - 倒计时结束后广播 `auctionEnded`
- **NTP 时间校准机制**：
  - 首次连接时，客户端发送 `clientTime`，服务端返回 `serverTime`
  - 计算偏移量 `offset = serverTime - clientTime`
  - 后续用 `Date.now() + offset` 模拟服务端时间，避免频繁请求
  - 定期（每 30 秒）重新校准，防止长时间运行后产生累积误差
- **requestAnimationFrame vs setInterval**：
  - `setInterval` 在浏览器标签页被挂起或性能不足时会出现掉帧，导致倒计时不准确
  - `requestAnimationFrame` 与浏览器渲染帧率同步，每次回调时计算真实经过的时间差
  - 这样即使出现掉帧，倒计时仍然基于真实时间，不会产生累积误差


