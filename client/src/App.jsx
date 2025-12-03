import React, { useEffect, useRef, useState } from "react";

const WS_URL = "ws://localhost:4000"; // 原生 WebSocket 地址

function formatRemain(ms) {
  if (ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const pad = (n) => (n < 10 ? "0" + n : n);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${pad(h)}:${pad(mm)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auction, setAuction] = useState(null); // 当前参与的活动
  const [bidAmount, setBidAmount] = useState("");
  const [message, setMessage] = useState("");
  const wsRef = useRef(null);

  // NTP 时间校准：本地时间偏移量（毫秒）
  // 计算方式：offset = serverTime - clientTime
  // 后续用 Date.now() + offset 来模拟服务端时间
  const timeOffsetRef = useRef(0);

  // requestAnimationFrame 相关
  const rafIdRef = useRef(null);
  const lastTimestampRef = useRef(null);
  const endTimeRef = useRef(null);

  // 计算当前服务端时间（本地时间 + 偏移量）
  const getServerNow = () => {
    return Date.now() + timeOffsetRef.current;
  };

  // 剩余时间（毫秒）- 直接在 RAF 中更新
  const [remainMs, setRemainMs] = useState(0);

  // 使用 requestAnimationFrame 实现倒计时（避免 setInterval 掉帧）
  useEffect(() => {
    if (!auction || auction.status === "ended") {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      lastTimestampRef.current = null;
      endTimeRef.current = null;
      setRemainMs(0);
      return;
    }

    // 初始化结束时间
    if (!endTimeRef.current) {
      endTimeRef.current = new Date(auction.end_time).getTime();
    }

    // 初始化 lastTimestamp，使用当前时间
    if (lastTimestampRef.current === null) {
      lastTimestampRef.current = Date.now();
    }

    // 立即计算一次剩余时间
    const updateRemainTime = () => {
      if (!endTimeRef.current) return;
      const serverNow = getServerNow();
      const remain = endTimeRef.current - serverNow;
      setRemainMs(remain > 0 ? remain : 0);
      return remain;
    };

    // 立即更新一次
    updateRemainTime();

    const animate = () => {
      const now = Date.now();

      // 计算真实经过的时间（毫秒）
      const deltaTime = now - lastTimestampRef.current;

      // 每 100ms 更新一次剩余时间（避免过于频繁的重渲染）
      // 注意：只有当满足条件时才更新时间戳，这样 deltaTime 才能累积
      if (deltaTime >= 100) {
        // 只有满足条件时才更新时间戳
        lastTimestampRef.current = now;

        const remain = updateRemainTime();

        // 检查是否已结束
        if (remain <= 0) {
          setAuction((prev) => {
            if (!prev) return prev;
            return { ...prev, status: "ended" };
          });
          setRemainMs(0);
          if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
          }
          return;
        }
      }

      rafIdRef.current = requestAnimationFrame(animate);
    };

    rafIdRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      lastTimestampRef.current = null;
    };
  }, [auction]);

  // NTP 时间校准函数
  const syncTime = async () => {
    const clientTime = Date.now();
    try {
      const res = await fetch("/api/time-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTime }),
      });
      if (!res.ok) {
        throw new Error("时间同步失败");
      }
      const { serverTime, clientTime: receivedClientTime } = await res.json();
      // 计算偏移量：offset = serverTime - clientTime
      const offset = serverTime - receivedClientTime;
      timeOffsetRef.current = offset;
      console.log(`[NTP] 时间校准完成，偏移量: ${offset}ms`);
      return offset;
    } catch (err) {
      console.error("时间同步失败，使用默认偏移量 0:", err);
      timeOffsetRef.current = 0;
      return 0;
    }
  };

  // 根据服务端时间字符串更新偏移量（用于 WebSocket 推送的时间校准）
  const updateTimeOffsetFromServerTime = (serverTimeStr) => {
    const serverTime = new Date(serverTimeStr).getTime();
    const clientTime = Date.now();
    timeOffsetRef.current = serverTime - clientTime;
  };

  useEffect(() => {
    let timeSyncInterval = null;

    async function init() {
      try {
        setLoading(true);
        setError("");

        // 第一步：NTP 时间校准
        await syncTime();

        // 第二步：获取拍卖列表
        const listRes = await fetch("/api/auctions");
        if (!listRes.ok) {
          throw new Error("获取拍卖列表失败");
        }
        const list = await listRes.json();
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error("当前没有任何拍卖，请检查后端或数据库");
        }
        const first = list[0];

        // 第三步：获取拍卖详情
        const detailRes = await fetch(`/api/auctions/${first.id}`);
        if (!detailRes.ok) {
          throw new Error("获取拍卖详情失败");
        }
        const detail = await detailRes.json();

        // 用服务端返回的时间再次校准（更精确）
        updateTimeOffsetFromServerTime(detail.serverTime);

        setAuction(detail.auction);
        endTimeRef.current = new Date(detail.auction.end_time).getTime();
        // 立即计算一次剩余时间
        const serverNow = getServerNow();
        const remain = endTimeRef.current - serverNow;
        setRemainMs(remain > 0 ? remain : 0);
        setBidAmount(String(Number(detail.auction.current_price) + 1));

        // 第四步：建立 WebSocket 连接
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          setMessage("已连接到实时服务器（WebSocket）");
          ws.send(
            JSON.stringify({
              type: "joinAuction",
              payload: { auctionId: detail.auction.id },
            })
          );
        };

        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch (e) {
            console.error("收到非 JSON 消息：", event.data);
            return;
          }
          const { type, data } = msg || {};

          if (type === "auctionData") {
            setAuction(data.auction);
            updateTimeOffsetFromServerTime(data.serverTime);
            endTimeRef.current = new Date(data.auction.end_time).getTime();
            // 立即更新倒计时
            const serverNow = getServerNow();
            const remain = endTimeRef.current - serverNow;
            setRemainMs(remain > 0 ? remain : 0);
          } else if (type === "bidUpdate") {
            setAuction((prev) => {
              if (!prev || prev.id !== data.auctionId) return prev;
              return {
                ...prev,
                current_price: data.newPrice,
              };
            });
            updateTimeOffsetFromServerTime(data.serverTime);
            // 立即更新倒计时
            if (endTimeRef.current) {
              const serverNow = getServerNow();
              const remain = endTimeRef.current - serverNow;
              setRemainMs(remain > 0 ? remain : 0);
            }
            setMessage(`用户 ${data.userId} 出价成功：${data.newPrice}`);
            setBidAmount(String(Number(data.newPrice) + 1));
          } else if (type === "auctionEnded") {
            setAuction((prev) => {
              if (!prev || prev.id !== data.auctionId) return prev;
              return { ...prev, status: "ended" };
            });
            updateTimeOffsetFromServerTime(data.serverTime);
            setRemainMs(0);
            setMessage("拍卖已结束");
          }
        };

        ws.onclose = () => {
          setMessage("与实时服务器断开连接");
        };

        ws.onerror = (err) => {
          console.error("WebSocket 错误：", err);
        };

        // 定期重新校准时间（每30秒一次）
        timeSyncInterval = setInterval(async () => {
          await syncTime();
        }, 30000);
      } catch (e) {
        console.error(e);
        setError(e.message || "初始化失败");
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {  
      // 关闭WebSocket连接、取消动画帧、清除时间同步定时器
      if (wsRef.current) {
        wsRef.current.close();
      }
      // 取消动画帧
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      // 清除时间同步定时器
      if (timeSyncInterval) {
        clearInterval(timeSyncInterval);
      }
    };
  }, []);

  const handleBid = async (e) => {
    e.preventDefault();
    if (!auction) return;
    const amount = Number(bidAmount);
    if (!amount || amount <= 0) {
      setMessage("请输入有效的出价金额");
      return;
    }
    try {
      setMessage("出价中...");
      const res = await fetch(`/api/auctions/${auction.id}/bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          userId: "user-" + Math.floor(Math.random() * 1000),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "出价失败");
      }
      setMessage("出价成功，等待广播同步...");
    } catch (err) {
      console.error(err);
      setMessage(err.message || "出价失败");
    }
  };

  return (
    <div className="page">
      <div className="card">
        <h1>竞价倒计时多端同步 Demo</h1>
        <p className="sub-title">React + Node.js + Socket.io + MySQL</p>

        {loading && <p>加载中...</p>}
        {error && <p className="error">{error}</p>}

        {auction && (
          <>
            <div className="section">
              <h2>拍卖信息</h2>
              <p>
                <strong>名称：</strong>
                {auction.name}
              </p>
              <p>
                <strong>当前价格：</strong>
                <span className="price">
                  ¥{Number(auction.current_price).toFixed(2)}
                </span>
              </p>
              <p>
                <strong>状态：</strong>
                <span className={`status status-${auction.status}`}>
                  {auction.status}
                </span>
              </p>
              <p>
                <strong>开始时间：</strong>
                {new Date(auction.start_time).toLocaleString()}
              </p>
              <p>
                <strong>结束时间：</strong>
                {new Date(auction.end_time).toLocaleString()}
              </p>
            </div>

            <div className="section">
              <h2>倒计时（以服务端时间为准）</h2>
              <div className="countdown">
                {auction.status === "ended" || remainMs <= 0
                  ? "已结束"
                  : formatRemain(remainMs)}
              </div>
              <p className="hint">
                当前服务端时间：{new Date(getServerNow()).toLocaleString()}
                <br />
                <small>时间偏移量: {timeOffsetRef.current}ms</small>
              </p>
            </div>

            <div className="section">
              <h2>出价</h2>
              {auction.status === "ended" || remainMs <= 0 ? (
                <p>拍卖已结束，无法继续出价。</p>
              ) : (
                <form onSubmit={handleBid} className="bid-form">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                  />
                  <button type="submit">出价</button>
                </form>
              )}
            </div>

            {message && (
              <div className="section">
                <h2>系统提示</h2>
                <p>{message}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
