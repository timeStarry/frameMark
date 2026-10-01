import { dimensions, outputSize, validateOutput, type Document } from '../core/document';
import { decode, fields, type Asset } from './assets';
export async function render(d: Document, a: Asset, canvas: HTMLCanvasElement, preview: boolean, check: () => void, status: (s: string) => void) { const logical = dimensions(d, a); const target = preview ? outputSize(logical, Math.min(1600, Math.max(logical.width, logical.height))) : outputSize(logical, d.longEdge); if (!preview)
    validateOutput(target); status('正在解码 1/1'); const bitmap = await decode(a.file, Math.max(target.width, target.height)); try {
    check();
    await document.fonts.ready;
    check();
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('无法创建画布，请降低输出尺寸。');
    const scale = target.width / logical.width;
    ctx.scale(scale, scale);
    const pad = Math.round(Math.min(a.width, a.height) * d.border / 100);
    ctx.fillStyle = d.color;
    if (d.frame === 'gradient') {
        const gradient = ctx.createLinearGradient(0, 0, logical.width, logical.height);
        gradient.addColorStop(0, d.color);
        gradient.addColorStop(1, d.secondColor);
        ctx.fillStyle = gradient;
    }
    if (!d.transparent || d.format === 'image/jpeg')
        ctx.fillRect(0, 0, logical.width, logical.height);
    if (d.frame === 'blur') {
        if (!('filter' in ctx))
            throw new Error('当前浏览器不支持模糊边框。');
        ctx.save();
        ctx.filter = `blur(${Math.min(a.width, a.height) * d.blur / 100}px)`;
        const r = Math.max(logical.width / bitmap.width, logical.height / bitmap.height) * 1.15;
        ctx.drawImage(bitmap, (logical.width - bitmap.width * r) / 2, (logical.height - bitmap.height * r) / 2, bitmap.width * r, bitmap.height * r);
        ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad, pad, a.width, a.height, Math.min(a.width, a.height) * d.radius / 100);
    ctx.clip();
    ctx.drawImage(bitmap, pad, pad, a.width, a.height);
    ctx.restore();
    status('正在绘制 1/1');
    const text = [d.text, ...d.fields.map(k => (d.fieldValues[k] || a.metadata[k]) ? `${fields[k] || k}: ${d.fieldValues[k] || a.metadata[k]}` : '')].filter(Boolean).join('\n');
    if (text) {
        await document.fonts.load(`${Math.min(a.width, a.height) * d.size / 100}px ${d.font}`, text);
        check();
        ctx.font = `${Math.min(a.width, a.height) * d.size / 100}px ${d.font}`;
        ctx.fillStyle = d.textColor;
        ctx.globalAlpha = d.opacity;
        const inset = Math.max(12, Math.min(a.width, a.height) * .025);
        const lines: string[] = [];
        for (const line of text.split('\n')) {
            let current = '';
            for (const char of line) {
                if (ctx.measureText(current + char).width > logical.width - inset * 2 && current) {
                    lines.push(current);
                    current = char;
                }
                else
                    current += char;
            }
            lines.push(current);
        }
        const row = Math.floor(d.position / 3), col = d.position % 3;
        ctx.textAlign = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
        ctx.textBaseline = 'top';
        const lineHeight = Math.min(a.width, a.height) * d.size / 100 * 1.4;
        if (lines.length * lineHeight > (d.frame === 'bottom-bar' ? logical.height - pad - a.height - inset : logical.height - inset * 2))
            throw new Error('文字超出可用高度，请减少文字、字号或增加底条高度。');
        const y = d.frame === 'bottom-bar' ? pad + a.height + inset : row === 0 ? inset : row === 1 ? (logical.height - lines.length * lineHeight) / 2 : logical.height - inset - lines.length * lineHeight;
        const x = col === 0 ? inset : col === 1 ? logical.width / 2 : logical.width - inset;
        lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
        ctx.globalAlpha = 1;
    }
    check();
}
finally {
    bitmap.close();
} }
export async function encode(canvas: HTMLCanvasElement, d: Document): Promise<Blob> { return new Promise((resolve, reject) => { canvas.toBlob(blob => { if (!blob)
    reject(new Error('编码失败，请尝试较小尺寸。'));
else if (blob.type !== d.format)
    reject(new Error('浏览器不支持此格式，请选择 PNG。'));
else
    resolve(blob); }, d.format, d.quality / 100); }); }
const downloads = new Map<string, ReturnType<typeof setTimeout>>();
export function disposeDownloads() { for (const [url, timer] of downloads) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
} downloads.clear(); }
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 30000)); }
