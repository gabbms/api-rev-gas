import { serverMessageSchema, type ClientMessage, type ServerMessage } from "@revgas/shared";
import { useEffect, useRef, useState } from "react";

type Listener = (msg: ServerMessage) => void;

/** One shared WebSocket to the server, reconnecting with a short pause. */
class Connection {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(online: boolean) => void>();
  online = false;

  constructor() {
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => this.setOnline(true);
    socket.onclose = () => {
      this.setOnline(false);
      setTimeout(() => this.connect(), 1500);
    };
    socket.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(data);
      if (parsed.success) for (const l of this.listeners) l(parsed.data);
    };
  }

  private setOnline(online: boolean) {
    this.online = online;
    for (const l of this.statusListeners) l(online);
  }

  send(msg: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  onStatus(l: (online: boolean) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }
}

export const connection = new Connection();

export function useServerMessages(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => connection.subscribe((m) => ref.current(m)), []);
}

export function useOnline() {
  const [online, setOnline] = useState(connection.online);
  useEffect(() => connection.onStatus(setOnline), []);
  return online;
}

/** Same rule as the server: digits only, drop country code 55 from 12–13 digit numbers. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

export function formatPhone(digits: string): string {
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  return rest.length === 9 ? `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}` : `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
}
