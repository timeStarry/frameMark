export type Frame = 'solid' | 'gradient' | 'blur' | 'bottom-bar';
export interface Document {
    assetIds: string[];
    frame: Frame;
    border: number;
    bottom: number;
    radius: number;
    color: string;
    secondColor: string;
    blur: number;
    text: string;
    font: string;
    size: number;
    opacity: number;
    textColor: string;
    position: number;
    fields: string[];
    fieldValues: Record<string, string>;
    transparent: boolean;
    format: 'image/jpeg' | 'image/png' | 'image/webp';
    quality: number;
    longEdge: number;
}
export const defaults = (): Document => ({ assetIds: [], frame: 'solid', border: 6, bottom: 15, radius: 0, color: '#f3f1ea', secondColor: '#b3b8ac', blur: 2, text: '', font: 'sans-serif', size: 2.5, opacity: 1, textColor: '#24282a', position: 7, fields: [], fieldValues: {}, transparent: false, format: 'image/jpeg', quality: 92, longEdge: 0 });
export interface Size {
    width: number;
    height: number;
}
export function dimensions(d: Document, source: Size): Size {
    const pad = Math.round(Math.min(source.width, source.height) * d.border / 100);
    return { width: source.width + pad * 2, height: source.height + pad * 2 + (d.frame === 'bottom-bar' ? Math.round(Math.min(source.width, source.height) * d.bottom / 100) : 0) };
}
export function outputSize(size: Size, longEdge: number): Size { const ratio = longEdge ? longEdge / Math.max(size.width, size.height) : 1; return { width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)) }; }
export function validateOutput(s: Size) { if (!Number.isFinite(s.width * s.height) || s.width < 1 || s.height < 1 || s.width * s.height > 16000000 || Math.max(s.width, s.height) > 8192)
    throw new Error('输出超过限制：最多 1600 万像素，长边 8192 px。请减小导出长边。'); }
export function applyPreset(d: Document, name: string): Document { const options: Record<string, Partial<Document>> = { light: { frame: 'solid', color: '#f3f1ea', border: 6, textColor: '#24282a' }, dark: { frame: 'solid', color: '#16191b', border: 6, textColor: '#eeeeea' }, soft: { frame: 'blur', border: 10, blur: 2, textColor: '#ffffff' }, caption: { frame: 'bottom-bar', border: 2, bottom: 18, color: '#f3f1ea', textColor: '#24282a' } }; return { ...d, ...options[name] }; }
export class History<T> {
    past: T[] = [];
    future: T[] = [];
    constructor(public value: T, readonly limit = 50) { }
    commit(next: T) { if (JSON.stringify(next) === JSON.stringify(this.value))
        return; this.past.push(structuredClone(this.value)); this.past = this.past.slice(-this.limit); this.value = structuredClone(next); this.future = []; }
    undo() { const prev = this.past.pop(); if (prev) {
        this.future.push(this.value);
        this.value = prev;
    } return this.value; }
    redo() { const next = this.future.pop(); if (next) {
        this.past.push(this.value);
        this.value = next;
    } return this.value; }
}
export class Jobs {
    version = 0;
    start() { return ++this.version; }
    cancel() { ++this.version; }
    check(id: number) { if (id !== this.version)
        throw new DOMException('已取消', 'AbortError'); }
}
