/*
 * Links between the browser and the meter. Each link delivers raw bytes to
 * onData(Uint8Array-like array) and reports a lost device through onClose.
 *
 *  HidLink     UT-D04 USB cable (WCH CH9325 / Hoitek HE2325U) via WebHID
 *  Cp2110Link  CP2110 bridge built into the UT61+/UT161 meters, via WebHID
 *  SerialLink  RS-232 UT-D02 or USB-serial adapters, via Web Serial
 *  SimLink     fake UT61C measuring a drifting voltage
 */
(function (root) {
  "use strict";

  const UTD04_IDS = [
    { vendorId: 0x1a86, productId: 0xe008 },   // WCH CH9325
    { vendorId: 0x04fa, productId: 0x2490 },   // Hoitek HE2325U
  ];
  const CP2110_IDS = [{ vendorId: 0x10c4, productId: 0xea80 }];
  const matches = (dev, ids) => ids.some((f) => f.vendorId === dev.vendorId && f.productId === dev.productId);
  const u8 = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

  class HidLink {
    static ids = UTD04_IDS;
    constructor(device, cfg) { this.device = device; this.cfg = cfg; }
    get label() { return this.device.productName || "Cable USB UT-D04"; }

    async open(onData, onClose) {
      this.onClose = onClose;
      if (!this.device.opened) await this.device.open();
      await this.configure();
      this.handler = (e) => this.onReport(e, onData);
      this.device.addEventListener("inputreport", this.handler);
    }

    /** Feature report: baud rate as little-endian uint32 followed by 0x03. */
    async configure() {
      const b = this.cfg.baud;
      await this.device.sendFeatureReport(0, new Uint8Array([b & 0xff, (b >> 8) & 0xff, (b >> 16) & 0xff, b >>> 24, 0x03]));
    }

    /** Each 8-byte report carries (byte0 & 0x0f) payload bytes from byte 1. */
    onReport(e, onData) {
      const d = u8(e.data);
      const n = Math.min(d[0] & 0x0f, d.length - 1);
      if (n) onData(Array.from(d.subarray(1, 1 + n)));
    }

    async close() {
      if (this.handler) this.device.removeEventListener("inputreport", this.handler);
      try { if (this.device.opened) await this.device.close(); } catch {}
    }
  }

  /**
   * UT61+/UT161: the CP2110 reports carry their payload length as report id,
   * both ways, and the meter only answers when asked.
   */
  class Cp2110Link extends HidLink {
    static ids = CP2110_IDS;
    get label() { return this.device.productName || "UT61+ (CP2110)"; }

    async configure() {
      const b = this.cfg.baud;
      await this.device.sendFeatureReport(0x41, new Uint8Array([0x01]));   // UART on
      await this.device.sendFeatureReport(0x50, new Uint8Array([         // baud, 8N1
        (b >>> 24) & 0xff, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff, 0x00, 0x00, 0x03, 0x00, 0x00]));
      await this.device.sendFeatureReport(0x43, new Uint8Array([0x02]));   // purge FIFOs
      const req = new Uint8Array(this.cfg.request);
      this.timer = setInterval(() => {
        this.device.sendReport(req.length, req).catch(() => {});
      }, 300);
    }

    onReport(e, onData) {
      const d = u8(e.data);
      onData(Array.from(d.subarray(0, Math.min(e.reportId, d.length))));
    }

    async close() {
      clearInterval(this.timer);
      await super.close();
    }
  }

  class SerialLink {
    constructor(port, cfg) { this.port = port; this.cfg = cfg; }
    get label() {
      const i = this.port.getInfo?.() || {};
      return i.usbVendorId ? `Puerto serie USB ${i.usbVendorId.toString(16).padStart(4, "0")}:${(i.usbProductId || 0).toString(16).padStart(4, "0")}` : "Puerto serie";
    }

    async open(onData, onClose) {
      await this.port.open({ baudRate: this.cfg.baud, dataBits: this.cfg.dataBits, parity: this.cfg.parity, stopBits: 1 });
      // the opto receiver of the RS-232 cable is powered from DTR (high) and RTS (low)
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: false }).catch(() => {});
      this.running = true;
      (async () => {
        try {
          while (this.running && this.port.readable) {
            this.reader = this.port.readable.getReader();
            try {
              for (;;) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) onData(Array.from(value));
              }
            } finally { this.reader.releaseLock(); }
          }
        } catch (e) {
          if (this.running) onClose(e.message || String(e));
        }
      })();
    }

    async close() {
      this.running = false;
      try { await this.reader?.cancel(); } catch {}
      try { await this.port.close(); } catch {}
    }
  }

  class SimLink {
    get label() { return "Simulador"; }
    async open(onData) {
      const t0 = Date.now();
      this.timer = setInterval(() => {
        const t = (Date.now() - t0) / 1000;
        const v = 3.3 + 0.6 * Math.sin(t / 8) + (Math.random() - 0.5) * 0.008;
        const counts = String(Math.round(Math.abs(v) * 1000)).padStart(4, "0");
        const bar = Math.min(Math.floor((Math.abs(v) / 6) * 42), 0x7f);
        onData([...(v < 0 ? "-" : "+") + counts + " 1"].map((c) => c.charCodeAt(0)).concat([0x31, 0, 0, 0x80, bar, 0x0d, 0x0a]));
      }, 400);
    }
    async close() { clearInterval(this.timer); }
  }

  /** Previously authorised HID devices that fit the link the model needs. */
  async function grantedHid(cfg) {
    if (!("hid" in navigator)) return [];
    const ids = cfg.link === "cp2110" ? CP2110_IDS : UTD04_IDS;
    return (await navigator.hid.getDevices()).filter((d) => matches(d, ids));
  }

  async function requestHid(cfg) {
    const ids = cfg.link === "cp2110" ? CP2110_IDS : UTD04_IDS;
    const [dev] = await navigator.hid.requestDevice({ filters: ids });
    return dev || null;
  }

  function makeHidLink(device, cfg) {
    return cfg.link === "cp2110" ? new Cp2110Link(device, cfg) : new HidLink(device, cfg);
  }

  root.Drivers = { HidLink, Cp2110Link, SerialLink, SimLink, grantedHid, requestHid, makeHidLink, UTD04_IDS, CP2110_IDS, matches };
})(globalThis);
