import { type Document } from '../core/document';
import { type CollageDocument } from '../core/collage';
import { render } from './render';
import { renderCollage } from './collage-render';
import type { Asset } from './assets';
export type ToolDocument = Document | CollageDocument;
export type Renderer<T> = (doc: T, assets: Map<string, Asset>, canvas: HTMLCanvasElement, preview: boolean, check: () => void, status: (s: string) => void) => Promise<void>;
export const renderDocument: Renderer<ToolDocument> = async (d, assets, canvas, preview, check, status) => { check(); if (d.kind === 'collage')
    await renderCollage(d, assets, canvas, preview, check, status);
else {
    const a = assets.get(d.assetIds[0] || '');
    if (!a)
        throw new Error('请先导入照片。');
    await render(d, a, canvas, preview, check, status);
} };
// Serialize preview/export jobs so cancelled browser decodes cannot multiply working memory.
export class SerialGate {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(job: () => Promise<T>): Promise<T> { const next = this.tail.then(job, job); this.tail = next.catch(() => { }); return next; }
}
