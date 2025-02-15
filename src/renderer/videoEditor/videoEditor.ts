import type { superRecording } from "../../ShareTypes";
import {
    addClass,
    button,
    check,
    ele,
    frame,
    input,
    label,
    pack,
    pureStyle,
    select,
    trackPoint,
    txt,
    view,
} from "dkh-ui";

const { ipcRenderer } = require("electron") as typeof import("electron");
const { uIOhook } = require("uiohook-napi") as typeof import("uiohook-napi");
const fs = require("node:fs") as typeof import("fs");

import { GIFEncoder, quantize, applyPalette } from "gifenc";

type clip = {
    i: number;
    rect: { x: number; y: number; w: number; h: number };
    transition: number; // 往前数
};

type uiData = {
    clipList: clip[];
    speed: { start: number; end: number; value: number }[];
    eventList: { start: number; end: number; value: unknown }[]; // todo
    remove: { start: number; end: number }[];
};

type FrameX = {
    rect: { x: number; y: number; w: number; h: number };
    timestamp: number;
    event: unknown[];
    isRemoved: boolean;
};

type baseType = (typeof outputType)[number]["type"];

const zeroPoint = [0, 0] as const;

const keys: superRecording = [];

let lastUiData: uiData | null = null;
let lastCodec = "";

const history: uiData[] = [];

let nowFrameX: FrameX[] = [];

// 播放、导出
const outputV = {
    width: 0,
    height: 0,
};

// todo 节省内存，可以降低原始分辨率，像鼠标坐标也要缩小
// src原始分辨率
const v = {
    width: 0,
    height: 0,
};

const codecMap = {
    vp8: "vp8",
    vp9: "vp09.00.10.08",
    av1: "av01.0.04M.08",
    avc: "avc1.42001F",
}; // todo 找到能用的编码

const codec = await (async () => {
    const codecs = ["av1", "vp9", "avc", "vp8"];
    for (const c of codecs) {
        const mc = codecMap[c];
        if (
            (await VideoDecoder.isConfigSupported({ codec: mc })) &&
            (await VideoEncoder.isConfigSupported({
                codec: mc,
                width: screen.width,
                height: screen.height,
            }))
        ) {
            return mc;
        }
    }
    return "vp8";
})();
console.log("codec", codec);

const srcRate = 60;
const bitrate = 16 * 1024 * 1024;

const outputType = [
    { type: "gif", name: "gif" },
    // { type: "webp", name: "webp" }, // todo
    // { type: "apng", name: "apng" }, // todo
    // { type: "avif", name: "avif" }, // todo
    { type: "webm", codec: "vp8", name: "webm-vp8" },
    { type: "webm", codec: "vp9", name: "webm-vp9" },
    { type: "webm", codec: "av1", name: "webm-av1" },
    { type: "mp4", codec: "avc", name: "mp4-avc" },
    { type: "mp4", codec: "vp9", name: "mp4-vp9" },
    { type: "mp4", codec: "av1", name: "mp4-av1" },
    { type: "png", name: "png" },
] as const;

let isPlaying = false;
let playI = 0;
let willPlayI = 0;
let playTime = 0;

// let isEditClip = false;

let mousePosi: { x: number; y: number } = { x: 0, y: 0 };

class videoChunk {
    list: EncodedVideoChunk[] = [];

    private lastDecodeFrame: OffscreenCanvas | null = null;
    private targetTime = 0;
    private frameDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            if (this.targetTime === frame.timestamp)
                this.lastDecodeFrame = frame2Canvas(frame);
            frame.close();
        },
        error: (e) => console.error("Decode error:", e),
    });

    constructor(_list: EncodedVideoChunk[]) {
        this.list = _list;
        this.frameDecoder.configure({
            codec: codec,
        });
    }
    setList(_list: EncodedVideoChunk[]) {
        this.list = _list;
    }
    get length() {
        return this.list.length;
    }
    async getFrame(index: number) {
        await this.frameDecoder.flush();
        const beforeId = this.list
            .slice(0, index + 1)
            .findLastIndex((c) => c.type === "key");

        console.log("getFrame", index, beforeId);

        this.targetTime = this.list[index].timestamp;
        this.lastDecodeFrame = null;
        for (let n = beforeId; n < index; n++) {
            this.frameDecoder.decode(this.list[n]);
        }
        this.frameDecoder.decode(this.list[index]);
        await this.frameDecoder.flush();
        return this.lastDecodeFrame as OffscreenCanvas | null;
    }
    frame2Id(frame: VideoFrame) {
        return this.list.findIndex((c) => c.timestamp === frame.timestamp);
    }
    time2Id(time: number) {
        const i = this.list.findIndex((c) => c.timestamp >= ms2timestamp(time));
        if (i === -1) return this.length - 1;
        return i;
    }
    getTime(id: number) {
        return timestamp2ms(this.list.at(id)?.timestamp ?? 0);
    }
    getDuration() {
        return this.getTime(-1);
    }
}

function frame2Canvas(frame: VideoFrame) {
    const canvas = new OffscreenCanvas(frame.codedWidth, frame.codedHeight);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(frame, 0, 0);
    return canvas;
}

function listLength() {
    return srcCs.length;
}

function initKeys() {
    function push(x: Omit<superRecording[0], "time" | "posi">) {
        keys.push({
            time: performance.now(),
            posi: mousePosi,
            ...x,
        });
    }
    uIOhook.on("keydown", (e) => {
        push({
            keydown: e.keycode.toString(),
        });
    });

    uIOhook.on("keyup", (e) => {
        push({
            keyup: e.keycode.toString(),
        });
    });

    const map = { 1: 0, 2: 1, 3: 2 } as const;

    uIOhook.on("mousedown", (e) => {
        push({
            mousedown: map[e.button as number],
        });
    });
    uIOhook.on("mouseup", (e) => {
        push({
            mouseup: map[e.button as number],
        });
    });

    uIOhook.on("wheel", (e) => {
        console.log(e.direction, e.rotation);
        push({ wheel: true });
    });

    uIOhook.on("mousemove", (e) => {
        mousePosi = { x: e.x, y: e.y };
        push({});
    });

    uIOhook.start();
}

async function afterRecord(chunks: EncodedVideoChunk[]) {
    // 补帧
    // todo 插入关键帧
    const m = new Map<number, number>();
    const d = Math.floor(ms2timestamp(1000 / srcRate));
    let index = 0;
    const frames = 150;
    const encodedChunks: EncodedVideoChunk[] = [];
    const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            const t = frame.timestamp;
            encoder.encode(frame, { keyFrame: index % frames === 0 });
            index++;
            for (let i = 1; i <= (m.get(frame.timestamp) ?? 0); i++) {
                const f = new VideoFrame(frame, { timestamp: t + d * i });
                encoder.encode(f, { keyFrame: index % frames === 0 });
                index++;
                f.close();
            }
            frame.close();
        },
        error: (e) => console.error("Encode error:", e),
    });
    const encoder = new VideoEncoder({
        output: (c: EncodedVideoChunk) => {
            encodedChunks.push(c);
        },
        error: (e) => console.error("Encode error:", e),
    });

    encoder.configure({
        codec: codec,
        framerate: srcRate,
        bitrate: bitrate,
        width: v.width,
        height: v.height,
    });
    decoder.configure({
        codec: codec,
    });
    let lastTime = 0;
    for (const c of chunks) {
        const count = Math.round((c.timestamp - lastTime) / d);
        if (count > 1) {
            m.set(lastTime, count - 1);
        }
        lastTime = c.timestamp;
    }
    for (const c of chunks) {
        decoder.decode(c);
    }
    await decoder.flush();
    await encoder.flush();
    decoder.close();
    encoder.close();
    return encodedChunks;
}

let stopRecord = () => {};

function ms2timestamp(t: number) {
    return t * 1000;
}

function timestamp2ms(t: number) {
    return t / 1000;
}

function numberPad(n: number, length = 2) {
    return n.toString().padStart(length, "0");
}

function formatTime(t: number) {
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const ms = Math.floor(t % 1000);
    return `${numberPad(h)}:${numberPad(m)}:${numberPad(s)}.${numberPad(ms, 3)}`;
}

function mapKeysOnFrames(chunks: EncodedVideoChunk[]) {
    const startTime = keys.find((k) => k.isStart)?.time;
    if (!startTime) {
        console.log(keys);
        throw new Error("no start key");
    }
    const newKeys = keys
        .map((i) => ({ ...i, time: i.time - startTime }))
        .filter((i) => i.time > 0);
    // 获取关键时间
    let lastK: (typeof newKeys)[0] | undefined = undefined;
    const nk = newKeys.filter(
        (k) =>
            "keydown" in k ||
            "keyup" in k ||
            "mousedown" in k ||
            "mouseup" in k,
    );
    const nk2: typeof newKeys = [];
    for (const k of nk) {
        if (k.time - (lastK?.time ?? 0) > 500) {
            nk2.push(k);
        }
        lastK = k;
    }

    for (const k of nk2) {
        const t = ms2timestamp(k.time);
        const chunk = chunks.findIndex(
            (c, i) =>
                c.timestamp <= t &&
                t < (chunks[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY),
        );
        if (chunk === -1) continue;
        const w = v.width / 3;
        const h = v.height / 3;
        const x = Math.max(0, Math.min(v.width - w, k.posi.x - w / 2));
        const y = Math.max(0, Math.min(v.height - h, k.posi.y - h / 2));
        getNowUiData().clipList.push({
            i: chunk,
            rect: { x, y, w: w, h: h },
            transition: ms2timestamp(400),
        });
    }
}

function getNowUiData() {
    return history.at(-1) as uiData; // todo 撤回指针等
}

function renderUiData(data: uiData) {
    // 均匀index分布显示
    timeLineClipEl.clear();
    timeLineSpeedEl.clear();
    timeLineEventEl.clear();
    timeLineRemoveEl.clear();

    function ipx(n: number) {
        return `${(n / listLength()) * 100}%`;
    }

    for (const [i, c] of data.clipList.entries()) {
        const beforeId = transformCs.time2Id(
            timestamp2ms(
                (transformCs.list.at(c.i - 1)?.timestamp ?? 0) - c.transition,
            ),
        );
        view()
            .addInto(timeLineClipEl)
            .style({
                left: ipx(beforeId),
                width: ipx(c.i - beforeId),
                backgroundColor: "red",
            })
            .on("click", () => {
                editClip(i);
            });
    }
    timeLineClipEl.el.ondblclick = (e) => {
        if (e.target === e.currentTarget) {
            const data = structuredClone(getNowUiData());
            const i = Math.floor(
                (e.offsetX / timeLineClipEl.el.offsetWidth) * listLength(),
            );
            const newClip: clip = {
                i: i,
                rect: { x: 0, y: 0, w: v.width, h: v.height },
                transition: ms2timestamp(400),
            };
            data.clipList.push(newClip);

            history.push(data);
            renderUiData(data);
            editClip(data.clipList.length - 1);
        }
    };

    for (const c of data.speed) {
        const el = view().addInto(timeLineSpeedEl);
        el.style({
            left: ipx(c.start),
            width: ipx(c.end - c.start),
            backgroundColor: "blue",
        });
    }

    for (const c of data.eventList) {
        const el = view().addInto(timeLineEventEl);
        el.style({
            left: ipx(c.start),
            width: ipx(c.end - c.start),
            backgroundColor: "green",
        });
    }

    for (const c of data.remove) {
        const el = view().addInto(timeLineRemoveEl);
        el.style({
            left: ipx(c.start),
            width: ipx(c.end - c.start),
            backgroundColor: "black",
        });
    }
}

function getFrameXs(_data: uiData) {
    const data: uiData = {
        clipList: _data.clipList.toSorted((a, b) => a.i - b.i),
        speed: _data.speed.toSorted((a, b) => a.start - b.start),
        eventList: _data.eventList.toSorted((a, b) => a.start - b.start),
        remove: _data.remove.toSorted((a, b) => a.start - b.start),
    };
    console.log(data);

    const frameList: FrameX[] = [];
    // todo speed map
    for (const [i, c] of srcCs.list.entries()) {
        const f: FrameX = {
            rect: { x: 0, y: 0, w: v.width, h: v.height },
            timestamp: c.timestamp,
            event: [],
            isRemoved: false,
        };

        f.isRemoved = data.remove.some((r) => r.start <= i && i <= r.end);
        if (f.isRemoved) {
            frameList.push(f);
            continue;
        }

        // clip
        if (data.clipList.length > 0) {
            // 补充首尾，方便查找区间
            const firstClip = structuredClone(
                data.clipList.at(0) as uiData["clipList"][0],
            );
            firstClip.i = 0;
            const lastClip = structuredClone(
                data.clipList.at(-1) as uiData["clipList"][0],
            );
            lastClip.i = listLength() - 1;
            const l = structuredClone(data.clipList);
            l.unshift(firstClip);
            l.push(lastClip);

            const bmClip = l.find((c) => c.i === i);
            if (bmClip) {
                f.rect = bmClip.rect;
            } else {
                const clipI = l.findLastIndex((c) => c.i < i);
                const clip = l[clipI];
                const nextClip = l[clipI + 1];
                const clipTime = srcCs.list[clip.i].timestamp; // todo map
                const nextClipTime = srcCs.list[nextClip.i].timestamp;
                const t = c.timestamp;
                f.rect = getClip(clip, clipTime, t, nextClip, nextClipTime);
            }
        }

        frameList.push(f);
    }

    return frameList;
}

function getClip(
    last: clip,
    lastT: number,
    t: number,
    next: clip,
    nextT: number,
) {
    const transition = Math.min(next.transition, nextT - lastT);
    if (t < nextT - transition || t > nextT) {
        return last.rect;
    }
    const v = easeOutQuint((t - (nextT - transition)) / transition);
    return {
        x: (1 - v) * last.rect.x + v * next.rect.x,
        y: (1 - v) * last.rect.y + v * next.rect.y,
        w: (1 - v) * last.rect.w + v * next.rect.w,
        h: (1 - v) * last.rect.h + v * next.rect.h,
    };
}

function easeOutQuint(x: number): number {
    return 1 - (1 - x) ** 5; // todo 更多 easing
}

async function transform(_codec = "") {
    const nowUi = getNowUiData();

    if (_codec === lastCodec) {
        if (JSON.stringify(nowUi) === JSON.stringify(lastUiData)) return;
    }
    lastCodec = _codec;
    lastUiData = nowUi;
    const frameXs = getFrameXs(nowUi);
    nowFrameX = frameXs;

    // todo diff 关键帧之间为单位，如果frameX在直接变动，则重新生成关键帧之后的chunck
    // todo diff 有的不变，有的变frame，有的变时间戳
    // todo keyframe webm 32s mp4 5-10s

    const transformed: EncodedVideoChunk[] = [];

    const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            // 解码 处理 编码
            const nFrame = transformX(frame);
            encoder.encode(nFrame); // todo key frame
            nFrame.close();
        },
        error: (e) => console.error("Decode error:", e),
    });
    const encoder = new VideoEncoder({
        output: (c: EncodedVideoChunk) => {
            // todo 这里有点难获取id，时间戳也是不保证的
            transformed.push(c);
        },
        error: (e) => console.error("Encode error:", e),
    });
    encoder.configure({
        codec: codecMap[_codec] ?? codec,
        width: outputV.width,
        height: outputV.height,
        framerate: srcRate,
        bitrate: bitrate,
    });
    decoder.configure({
        codec: codec,
    });
    for (const chunk of srcCs.list) {
        decoder.decode(chunk);
    }
    /**@see {@link ../../docs/develop/superRecorder.md#转换（编辑）} */
    await decoder.flush();
    await encoder.flush();
    decoder.close();
    encoder.close();
    transformCs.setList(transformed);
}

function transformX(frame: VideoFrame) {
    const t = renderFrameX(frame);
    const canvas = t.canvas;
    const nFrame = new VideoFrame(canvas, {
        timestamp: t.time,
    });
    return nFrame;
}

function renderFrameX(frame: VideoFrame) {
    const frameX = nowFrameX.at(srcCs.frame2Id(frame));
    const canvas = new OffscreenCanvas(outputV.width, outputV.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    if (!frameX) {
        console.log(
            `frame ${frame.timestamp} ${srcCs.frame2Id(frame)} not found in uiData`,
        );
        return { canvas, time: frame.timestamp };
    }
    const clip = frameX.rect;
    ctx.drawImage(
        frame,
        clip.x,
        clip.y,
        clip.w,
        clip.h,
        ...zeroPoint,
        outputV.width,
        outputV.height,
    );
    const time = frameX.timestamp;
    frame.close();
    return { canvas, time };
}

async function playId(i: number, force = false) {
    if (i === playI && !force) return;

    const transformed = transformCs.list;
    if (transformed[i].type === "key") {
        playDecoder.decode(transformed[i]);
        playI = i;
        willPlayI = i;
        return;
    }
    const beforeId = transformed
        .slice(0, i)
        .findLastIndex((c) => c.type === "key");

    const fillI = i < playI || playI < beforeId ? beforeId : playI + 1;

    for (let n = fillI; n < i; n++) {
        playDecoder.decode(transformed[n]);
    }
    playDecoder.decode(transformed[i]);
    playI = i;
    willPlayI = i;
    console.log("play", playI);
}

async function play() {
    const dTime = performance.now() - playTime;
    onPlay(dTime);

    if (isPlaying) {
        const i = transformCs.time2Id(dTime);
        await playId(i);

        if (playI === listLength() - 1) {
            playEnd();
        }

        requestAnimationFrame(() => {
            play();
        });
    }
}

function onPlay(dTime: number) {
    playTimeEl.sv(dTime);
    timeLineControlPoint.sv(transformCs.time2Id(dTime));
}

function setPlaySize() {
    canvas.width = outputV.width;
    canvas.height = outputV.height;
}

function resetPlayTime() {
    const dTime = timestamp2ms(transformCs.list[playI].timestamp);
    playTime = performance.now() - dTime;
}

async function jump2id(id: number) {
    const fcanvas = await transformCs.getFrame(id);
    if (!fcanvas) {
        console.log("no frame", id);
        return;
    }
    canvas
        .getContext("2d")
        ?.drawImage(
            fcanvas,
            ...zeroPoint,
            fcanvas.width,
            fcanvas.height,
            ...zeroPoint,
            outputV.width,
            outputV.height,
        );
    willPlayI = id;
}

async function jump2idUi(id: number) {
    await jump2id(id);
    await showNowFrames(id);
    playTimeEl.sv(transformCs.getTime(id));
    timeLineControlPoint.sv(id);
}

function pause() {
    isPlaying = false;

    onPause();
}

async function playEnd() {
    isPlaying = false;
    playEl.sv(false);

    await playId(0, true);

    onPause();
}

function onPause() {
    showNowFrames(playI);
}

async function showThumbnails() {
    await transform();
    timeLineMain.clear();
    for (let i = 0; i < 6; i++) {
        const id = Math.floor((i / 6) * listLength());
        const canvas = await transformCs.getFrame(id);
        if (!canvas) {
            console.log("no frame", id);
            continue;
        }
        const tW = 300;
        const tH = Math.floor((tW * outputV.height) / outputV.width);

        const canvasEl = ele("canvas")
            .attr({
                width: tW,
                height: tH,
            })
            .style({ width: "calc(100% / 6)", pointerEvents: "none" });
        (canvasEl.el.getContext("2d") as CanvasRenderingContext2D).drawImage(
            canvas,
            ...zeroPoint,
            outputV.width,
            outputV.height,
            ...zeroPoint,
            tW,
            tH,
        );
        timeLineMain.add(canvasEl);
    }
}

async function showNowFrames(centerId: number) {
    await transform();
    const hasI: number[] = [];
    for (const c of timeLineFrame.queryAll(":scope > *")) {
        const i = Number(c.el.getAttribute("data-i"));
        if (i < centerId - 3 || centerId + 4 <= i) {
            c.remove();
        } else {
            hasI.push(i);
        }
    }
    for (let i = centerId - 3; i < centerId + 4; i++) {
        if (hasI.includes(i)) continue;
        const id = i;
        const c = view()
            .style({ width: "calc(100% / 7)", order: i })
            .data({ i: String(i) });

        const tW = 300;
        const tH = Math.floor((tW * outputV.height) / outputV.width);

        if (0 <= i && i < listLength()) {
            const canvas = await transformCs.getFrame(id);
            if (!canvas) {
                console.log("no frame", id);
                continue;
            }
            const canvasEl = ele("canvas")
                .attr({
                    width: tW,
                    height: tH,
                })
                .style({ maxWidth: "100%" })
                .on("click", () => {
                    jump2idUi(id);
                });
            (
                canvasEl.el.getContext("2d") as CanvasRenderingContext2D
            ).drawImage(
                canvas,
                ...zeroPoint,
                outputV.width,
                outputV.height,
                ...zeroPoint,
                tW,
                tH,
            );
            c.add(canvasEl);
            c.add(formatTime(transformCs.getTime(id)));
        }
        timeLineFrame.add(c);
    }

    for (const c of timeLineFrame.queryAll(":scope > *")) {
        const i = Number(c.el.getAttribute("data-i"));
        if (i === centerId) {
            c.class(timeLineFrameHl);
        } else {
            c.el.classList.remove(timeLineFrameHl);
        }
    }
}

function editClip(i: number) {
    type center = { x: number; y: number; ratio: number };

    const data = structuredClone(getNowUiData());

    const clip = data.clipList.at(i);
    if (!clip) return;

    const rect = clip.rect;

    function rect2center(rect: clip["rect"]) {
        return {
            x: rect.x + rect.w / 2,
            y: rect.y + rect.h / 2,
            ratio: rect.w / v.width,
        };
    }

    function center2rect(center: center) {
        const w = v.width * center.ratio;
        const h = v.height * center.ratio;
        let x = center.x - w / 2;
        let y = center.y - h / 2;
        x = Math.min(Math.max(0, x), v.width - w);
        y = Math.min(Math.max(0, y), v.height - h);
        return { x, y, w, h };
    }

    async function jump2id(id: number) {
        const src = await srcCs.getFrame(id);
        if (!src) return;
        clipCanvas.width = v.width;
        clipCanvas.height = v.height;
        clipCanvas.getContext("2d")?.drawImage(src, 0, 0);
        clipControl.sv(rect);
    }

    async function save() {
        canvasView.sv("play");
        history.push(data);
        await transform();
        await showThumbnails();
        await showNowFrames(willPlayI);
    }

    function reRener() {
        renderUiData(data); // todo 部分更新
    }

    const centerPoint = rect2center(rect);

    const clipMoveLast = button("移到上一帧").on("click", () => {
        // todo 跳过其他clip
        const i = Math.max(0, clip.i - 1);
        clip.i = i;
        jump2id(i);
        reRener();
    });
    const clipMoveNext = button("移到下一帧").on("click", () => {
        // todo 跳过其他clip
        const i = Math.min(listLength() - 1, clip.i + 1);
        clip.i = i;
        jump2id(i);
        reRener();
    });
    const clipTransition = label(
        [
            input("number")
                .attr({ min: "0", step: "100" })
                .style({
                    // @ts-ignore
                    "field-sizing": "content",
                })
                .bindSet((v: number, el) => {
                    el.value = timestamp2ms(v).toFixed(0);
                })
                .bindGet((el) => {
                    return ms2timestamp(Number(el.value));
                })
                .sv(clip.transition)
                .on("input", (_, el) => {
                    clip.transition = el.gv;
                    reRener();
                }),
            "过渡",
        ],
        1,
    );
    const clipRemove = button("删除").on("click", () => {
        data.clipList.splice(i, 1);
        reRener();
        save();
    });
    const clipSave = button("保存").on("click", () => {
        save();
    });
    const clipGiveUp = button("放弃").on("click", () => {
        canvasView.sv("play");
        const nowUi = getNowUiData();
        renderUiData(nowUi);
    });

    const clipCanvasEl = ele("canvas");
    const clipCanvas = clipCanvasEl.el;
    const clipControl = view()
        .style({
            position: "absolute",
            boxShadow: "0px 0px 0 1px #fff, 0px 0px 0 2px #000",
        })
        .bindSet((rect: clip["rect"], el) => {
            const w = v.width;
            const h = v.height;
            pack(el).style({
                left: `${(rect.x / w) * 100}%`,
                top: `${(rect.y / h) * 100}%`,
                width: `${(rect.w / w) * 100}%`,
                height: `${(rect.h / h) * 100}%`,
            });
        })
        .on("wheel", (e) => {
            e.preventDefault();
            centerPoint.ratio *= Math.sqrt(1 - e.deltaY / 1000);
            const r = center2rect(centerPoint);
            clipControl.sv(r);
            rect.x = r.x;
            rect.y = r.y;
            rect.w = r.w;
            rect.h = r.h;
        });

    trackPoint(clipControl, {
        start: () => {
            return { x: centerPoint.x, y: centerPoint.y };
        },
        ing: (p) => {
            const r = v.width / clipCanvas.width;
            const x = p.x * r;
            const y = p.y * r;
            centerPoint.x = x;
            centerPoint.y = y;
            const rect = center2rect(centerPoint);
            clipControl.sv(rect);
            return rect;
        },
        end: (_, { ingData }) => {
            if (ingData) {
                rect.x = ingData.x;
                rect.y = ingData.y;
                rect.w = ingData.w;
                rect.h = ingData.h;
                const cp = rect2center(rect);
                centerPoint.x = cp.x;
                centerPoint.y = cp.y;
            }
        },
    });

    clipEditor
        .clear()
        .add([
            view()
                .style({ position: "relative" })
                .add([clipCanvas, clipControl]),
            view("x").add([
                clipMoveLast,
                clipMoveNext,
                clipRemove,
                clipTransition,
                clipSave,
                clipGiveUp,
            ]),
        ]);

    canvasView.sv("clip");

    jump2id(clip.i);
}

async function save() {
    if (exportEl.els.type.gv === "png") saveImages();
    else if (exportEl.els.type.gv === "gif") saveGif();
    else if (exportEl.els.type.gv === "webm-av1") saveWebm("av1");
    else if (exportEl.els.type.gv === "webm-vp9") saveWebm("vp9");
    else if (exportEl.els.type.gv === "webm-vp8") saveWebm("vp8");
    else if (exportEl.els.type.gv === "mp4-av1") saveMp4("av1");
    else if (exportEl.els.type.gv === "mp4-vp9") saveMp4("vp9");
    else if (exportEl.els.type.gv === "mp4-avc") saveMp4("avc");
}

function getSavePath(type: baseType) {
    return ipcRenderer.sendSync(
        "get_save_file_path",
        type,
        type === "mp4" || type === "webm",
    );
}

async function saveImages() {
    const exportPath = getSavePath("png");

    try {
        fs.mkdirSync(exportPath, { recursive: true });
    } catch (error) {}

    const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            const t = renderFrameX(frame);
            t.canvas.convertToBlob({ type: "image/png" }).then(async (blob) => {
                const buffer = Buffer.from(await blob.arrayBuffer());
                fs.writeFile(
                    `${exportPath}/${t.time}.png`,
                    buffer,
                    (_err) => {},
                );
            });
        },
        error: (e) => console.error("Decode error:", e),
    });
    decoder.configure({
        codec: codec,
    });
    for (const chunk of srcCs.list) {
        decoder.decode(chunk);
    }

    await decoder.flush();
    ipcRenderer.send("ok_save", exportPath);

    decoder.close();

    console.log("decoded");
}

async function saveGif() {
    const exportPath = getSavePath("gif");

    const gif = GIFEncoder();

    const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            const { data, width, height } = (
                renderFrameX(frame).canvas.getContext(
                    "2d",
                ) as OffscreenCanvasRenderingContext2D
            ).getImageData(0, 0, outputV.width, outputV.height);
            const palette = quantize(data, 256);
            const index = applyPalette(data, palette);
            gif.writeFrame(index, width, height, {
                palette,
            });
        },
        error: (e) => console.error("Decode error:", e),
    });
    decoder.configure({
        codec: codec,
    });
    for (const chunk of srcCs.list) {
        decoder.decode(chunk);
    }

    await decoder.flush();
    decoder.close();
    gif.finish();
    const bytes = gif.bytes();
    fs.writeFileSync(exportPath, Buffer.from(bytes));
    ipcRenderer.send("ok_save", exportPath);
}

async function saveWebm(_codec: "vp8" | "vp9" | "av1") {
    const { Muxer, ArrayBufferTarget } = require("webm-muxer") as typeof import(
        "webm-muxer"
    );
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
            codec: `V_${_codec.toUpperCase()}`,
            width: outputV.width,
            height: outputV.height,
            frameRate: srcRate,
        },
    });

    await transform(_codec);

    for (const chunk of transformCs.list) {
        muxer.addVideoChunk(chunk);
    }
    muxer.finalize();
    const { buffer } = muxer.target;
    const exportPath = getSavePath("webm");
    fs.writeFileSync(exportPath, Buffer.from(buffer));
    console.log("saved webm");
    ipcRenderer.send("ok_save", exportPath, true);
}

async function saveMp4(_codec: "avc" | "vp9" | "av1") {
    const { Muxer, ArrayBufferTarget } = require("mp4-muxer") as typeof import(
        "mp4-muxer"
    );
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
            codec: _codec,
            width: outputV.width,
            height: outputV.height,
            frameRate: srcRate,
        },
        fastStart: false,
    });

    await transform(_codec);

    for (const chunk of transformCs.list) {
        muxer.addVideoChunk(chunk);
    }
    muxer.finalize();
    const { buffer } = muxer.target;
    const exportPath = getSavePath("mp4");
    fs.writeFileSync(exportPath, Buffer.from(buffer));
    console.log("saved mp4");
    ipcRenderer.send("ok_save", exportPath, true);
}

const transformCs = new videoChunk([]);
const srcCs = new videoChunk([]);

const playDecoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(
            frame,
            ...zeroPoint,
            frame.codedWidth,
            frame.codedHeight,
            ...zeroPoint,
            outputV.width,
            outputV.height,
        );
        frame.close();
    },
    error: (e) => console.error("Decode error:", e),
});
playDecoder.configure({
    codec: codec,
});

const canvasEl = ele("canvas");
const canvas = canvasEl.el;

const clipEditor = view("y");

const canvasView = view()
    .add([canvasEl, clipEditor])
    .addInto()
    .bindSet((type: "play" | "clip") => {
        if (type === "play") {
            canvasEl.style({ display: "block" });
            clipEditor.style({ display: "none" });
        } else {
            canvasEl.style({ display: "none" });
            clipEditor.style({ display: "block" });
        }
    })
    .sv("play");

const actionsEl = view("x").addInto();
const playEl = check("", ["||", "|>"]).on("input", async () => {
    if (playEl.gv) {
        await transform();
        isPlaying = true;
        if (playI === transformCs.length - 1) {
            playI = 0;
        }
        if (willPlayI !== playI) {
            await playId(willPlayI);
        }

        resetPlayTime();
        play();
    } else {
        pause();
    }
});

const lastFrame = button("<").on("click", () => {
    const id = Math.max(willPlayI - 1, 0);
    jump2idUi(id);
});
const nextFrame = button(">").on("click", () => {
    const id = Math.min(willPlayI + 1, transformCs.length - 1);
    jump2idUi(id);
});
const lastKey = button("<<");
const nextKey = button(">>");

const playTimeEl = txt().bindSet((t: number, el) => {
    el.innerText = `${formatTime(t)} / ${formatTime(transformCs.getDuration())}`;
});

actionsEl.add([lastKey, lastFrame, playEl, nextFrame, nextKey, playTimeEl]);

const timeLineMain = view("x")
    .addInto()
    .on("click", (e) => {
        const p = e.offsetX / timeLineMain.el.offsetWidth;
        const id = transformCs.time2Id(p * transformCs.getDuration());
        jump2idUi(id);
    });

const timeLineControl = view("y")
    .style({ height: "64px", position: "relative" })
    .class(
        addClass(
            {},
            {
                "& > *": {
                    position: "relative",
                    width: "100%",
                    height: "100%",
                },
                "& > * > *": {
                    position: "absolute",
                    minWidth: "4px",
                    height: "100%",
                },
            },
        ),
    )
    .addInto()
    .on("click", (e) => {
        const p = e.offsetX / timeLineMain.el.offsetWidth;
        const id = Math.floor(p * transformCs.length);
        jump2idUi(id);
    });
const timeLineControlPoint = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "2px",
        height: "100%",
        backgroundColor: "red",
    })
    .addInto(timeLineControl)
    .bindSet((i: number, el) => {
        el.style.left = `${(i / transformCs.length) * 100}%`;
    });

const timeLineClipEl = view().addInto(timeLineControl);
const timeLineSpeedEl = view().addInto(timeLineControl);
const timeLineEventEl = view().addInto(timeLineControl);
const timeLineRemoveEl = view().addInto(timeLineControl);

const timeLineFrame = view("x").addInto();
const timeLineFrameHl = addClass({ border: "solid 1px #000" }, {});

const exportPx = select([]);

const exportEl = frame("export", {
    _: view("x"),
    export: button("导出").on("click", save),
    type: select(outputType.map((t) => ({ value: t.name }))),
    px: exportPx,
    editClip: button("编辑").on("click", async () => {
        const canvas = await transformCs.getFrame(willPlayI);
        if (!canvas) return;
        canvas.convertToBlob({ type: "image/png" }).then(async (blob) => {
            const buffer = Buffer.from(await blob.arrayBuffer());
            ipcRenderer.send("ding_edit", buffer);
        });
    }),
    editSrc: button("编辑原图").on("click", async () => {
        const canvas = await srcCs.getFrame(willPlayI);
        if (!canvas) return;
        canvas.convertToBlob({ type: "image/png" }).then(async (blob) => {
            const buffer = Buffer.from(await blob.arrayBuffer());
            ipcRenderer.send("ding_edit", buffer);
        });
    }),
});

exportEl.el.addInto();

pureStyle();

ipcRenderer.on("record", async (_e, _t, sourceId) => {
    // return
    let stream: MediaStream | undefined;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                // @ts-ignore
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: sourceId,
                },
            },
        });
    } catch (e) {
        console.error(e);
    }
    if (!stream) return;

    const videoTrack = stream.getVideoTracks()[0];

    const encoder = new VideoEncoder({
        output: (c: EncodedVideoChunk) => {
            encodedChunks.push(c);
        },
        error: (e) => console.error("Encode error:", e),
    });

    const videoWidth = videoTrack.getSettings().width ?? screen.width;
    const videoHeight = videoTrack.getSettings().height ?? screen.height;

    encoder.configure({
        codec: codec,
        width: videoWidth,
        height: videoHeight,
        framerate: srcRate,
        bitrate: bitrate,
    });
    v.width = videoWidth;
    v.height = videoHeight;

    for (const x of [1, 2, 4, 8]) {
        exportPx.add(
            ele("option").attr({
                value: String(x),
                text: `/${x} ${Math.round(v.width / x)} x ${Math.round(v.height / x)}`,
            }),
        );
    }
    exportPx
        .on("change", () => {
            const x = Number(exportPx.gv);
            outputV.width = Math.round(v.width / x);
            outputV.height = Math.round(v.height / x);
            setPlaySize();
            transform();
        })
        .sv("2");

    outputV.width = Math.round(videoWidth / 2);
    outputV.height = Math.round(videoHeight / 2);

    // @ts-ignore
    const reader = new MediaStreamTrackProcessor({
        track: videoTrack,
    }).readable.getReader();

    // 读取视频帧并编码

    const encodedChunks: EncodedVideoChunk[] = [];

    initKeys();
    keys.push({ time: performance.now(), isStart: true, posi: { x: 0, y: 0 } });

    stopRecord = async () => {
        console.log("stop");

        uIOhook.stop();

        reader.cancel();

        await encoder.flush();
        encoder.close();

        const afterCuncks = await afterRecord(encodedChunks);

        console.log(afterCuncks);
        console.log(keys);

        history.push({ clipList: [], eventList: [], remove: [], speed: [] });

        srcCs.setList(afterCuncks);

        mapKeysOnFrames(afterCuncks);
        ipcRenderer.send("window", "show");
        ipcRenderer.send("window", "max");

        await transform();

        setPlaySize();

        await playId(0, true);

        await showThumbnails();
        await showNowFrames(0);

        const nowUi = getNowUiData();
        renderUiData(nowUi);
    };

    setTimeout(() => stopRecord(), 5 * 1000);

    while (true) {
        const { done, value: videoFrame } = await reader.read();
        if (done) break;
        if (encoder.encodeQueueSize > 2) {
            videoFrame.close();
        } else {
            encoder.encode(videoFrame);
            videoFrame.close();
        }
    }
});
