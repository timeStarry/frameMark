import { ref, shallowRef, computed, watch, onMounted, onUnmounted, type Ref } from 'vue';
import { History, Jobs, type OutputSettings, type Size } from './document';
import { Assets, type Asset } from '../engine/assets';
import { encode, download, disposeDownloads } from '../engine/render';
import { SerialGate, type Renderer } from '../engine/pipeline';
export function useEditor<T extends OutputSettings>(initial: () => T, renderer: Renderer<T>, output: (d: T, assets: Map<string, Asset>) => Size | null, maxAssets: number) {
    const repository = new Assets(), history = new History(initial()), previewJobs = new Jobs(), tasks = new Jobs(), gate = new SerialGate();
    const doc = ref(initial()) as Ref<T>, canvas = shallowRef<HTMLCanvasElement>(), selected = ref(''), error = ref(''), status = ref(''), busy = ref(false), revision = ref(0), exportOpen = ref(false), result = shallowRef<Blob>(), resultRevision = ref(-1), filename = ref('markr');
    let timer = 0, disposed = false;
    const snapshot = (): T => JSON.parse(JSON.stringify(doc.value));
    const assets = computed(() => { revision.value; return doc.value.assetIds.map(id => repository.items.get(id)).filter((a): a is Asset => !!a); });
    const canUndo = computed(() => { revision.value; return history.past.length > 0; }), canRedo = computed(() => { revision.value; return history.future.length > 0; }), size = computed(() => output(doc.value, repository.items));
    function prune() { repository.prune(new Set([...doc.value.assetIds, ...history.past.flatMap(d => d.assetIds), ...history.future.flatMap(d => d.assetIds)])); }
    function commit() { history.commit(snapshot()); revision.value++; prune(); }
    function restore(next: T) {
        doc.value = structuredClone(next);
        if (!doc.value.assetIds.includes(selected.value))
            selected.value = doc.value.assetIds[0] || '';
        revision.value++;
        prune();
    }
    function undo() { if (busy.value) return; commit(); restore(history.undo()); }
    function redo() { if (busy.value) return; restore(history.redo()); }
    function reset() { if (busy.value) return; doc.value = { ...initial(), assetIds: [...doc.value.assetIds] }; commit(); }
    function remove(id: string) {
        if (busy.value) return;
        const index = doc.value.assetIds.indexOf(id);
        doc.value.assetIds = doc.value.assetIds.filter(x => x !== id);
        if (selected.value === id)
            selected.value = doc.value.assetIds[Math.min(index, doc.value.assetIds.length - 1)] || '';
        commit();
    }
    function clear() {
        if (busy.value) return;
        if (!confirm('清空当前素材？可以撤销恢复。'))
            return;
        doc.value.assetIds = [];
        selected.value = '';
        commit();
    }
    function cancel() { tasks.cancel(); busy.value = false; status.value = '已取消；同步绘制和浏览器编码不能物理中断，完成结果将丢弃。'; }
    async function importFiles(files: File[], replaceId?: string, replace?: (d: T, oldId: string, newId: string) => T) {
        if (busy.value || !files.length)
            return;
        commit();
        const id = tasks.start();
        busy.value = true;
        error.value = '';
        const errors: string[] = [];
        let completed = 0;
        try {
            await gate.run(async () => {
                for (const [index, file] of files.entries()) {
                    tasks.check(id);
                    if (doc.value.assetIds.length >= maxAssets && !replaceId) {
                        errors.push('已达到 ' + maxAssets + ' 张素材上限');
                        break;
                    }
                    status.value = `正在导入 ${index + 1}/${files.length}`;
                    let a: Asset | undefined;
                    try {
                        a = await repository.add(file);
                        tasks.check(id);
                        if (replaceId) {
                            if (replace)
                                doc.value = replace(snapshot(), replaceId, a.id);
                            else
                                doc.value.assetIds = [a.id];
                        }
                        else
                            doc.value.assetIds.push(a.id);
                        selected.value = a.id;
                        completed++;
                        revision.value++;
                        if (maxAssets === 1 || replaceId)
                            break;
                    }
                    catch (e) {
                        if (a && !doc.value.assetIds.includes(a.id))
                            repository.prune(new Set([...repository.items.keys()].filter(k => k !== a!.id)));
                        if ((e as Error).name === 'AbortError')
                            throw e;
                        errors.push(file.name + '：' + (e as Error).message);
                    }
                }
            });
            tasks.check(id);
            status.value = completed ? `已导入 ${completed} 张` : '导入失败，请检查文件后重试';
            error.value = errors.join('\n');
        }
        catch (e) {
            if (id === tasks.version && (e as Error).name !== 'AbortError') {
                error.value = (e as Error).message;
                status.value = '操作失败；设置已保留，可以重试。';
            }
        }
        finally {
            if (!disposed) {
                commit();
                if (id === tasks.version)
                    busy.value = false;
            }
        }
    }
    async function preview() {
        const d = snapshot();
        if (!d.assetIds.length || !canvas.value) {
            previewJobs.cancel();
            return;
        }
        const id = previewJobs.start();
        await gate.run(async () => {
            const target = document.createElement('canvas');
            try {
                previewJobs.check(id);
                await renderer(d, repository.items, target, true, () => previewJobs.check(id), () => { });
                previewJobs.check(id);
                if (!canvas.value)
                    return;
                canvas.value.width = target.width;
                canvas.value.height = target.height;
                canvas.value.getContext('2d')?.drawImage(target, 0, 0);
            }
            catch (e) {
                if (id === previewJobs.version && (e as Error).name !== 'AbortError') {
                    error.value = (e as Error).message;
                    status.value = '操作失败；设置已保留，可以重试。';
                }
            }
            finally {
                target.width = target.height = 0;
            }
        });
    }
    watch(doc, () => { resultRevision.value = -1; previewJobs.cancel(); clearTimeout(timer); timer = window.setTimeout(() => void preview(), 150); }, { deep: true });
    watch(canvas, () => void preview(), { flush: 'post' });
    async function exportImage() {
        if (busy.value || !doc.value.assetIds.length)
            return;
        commit();
        previewJobs.cancel();
        clearTimeout(timer);
        const id = tasks.start(), d = snapshot(), rev = revision.value;
        busy.value = true;
        error.value = '';
        result.value = undefined;
        try {
            await gate.run(async () => {
                tasks.check(id);
                const target = document.createElement('canvas');
                try {
                    await renderer(d, repository.items, target, false, () => tasks.check(id), s => {
                        if (id === tasks.version)
                            status.value = s;
                    });
                    tasks.check(id);
                    status.value = '正在编码（不提供百分比）';
                    const blob = await encode(target, d);
                    tasks.check(id);
                    result.value = blob;
                    resultRevision.value = rev;
                    status.value = `导出完成 · ${(blob.size / 1024 / 1024).toFixed(2)} MiB`;
                }
                finally {
                    target.width = target.height = 0;
                }
            });
        }
        catch (e) {
            if (id === tasks.version && (e as Error).name !== 'AbortError') {
                error.value = (e as Error).message;
                status.value = '操作失败；设置已保留，可以重试。';
            }
        }
        finally {
            if (id === tasks.version)
                busy.value = false;
        }
    }
    function save() {
        if (!result.value || resultRevision.value !== revision.value)
            return;
        download(result.value, `${filename.value.replace(/[\\/:*?"<>|]/g, '-') || 'markr'}.${doc.value.format.split('/')[1]!.replace('jpeg', 'jpg')}`);
    }
    function keyboard(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            busy.value ? cancel() : exportOpen.value = false;
        }
        if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false])'))
            return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (!busy.value) e.shiftKey ? redo() : undo();
        }
    }
    onMounted(() => window.addEventListener('keydown', keyboard));
    onUnmounted(() => {
        disposed = true;
        window.removeEventListener('keydown', keyboard);
        clearTimeout(timer);
        previewJobs.cancel();
        tasks.cancel();
        repository.dispose();
        disposeDownloads();
        if (canvas.value)
            canvas.value.width = canvas.value.height = 0;
    });
    return { doc, assets, canvas, selected, error, status, busy, revision, exportOpen, result, resultRevision, filename, canUndo, canRedo, size, snapshot, commit, undo, redo, reset, remove, clear, cancel, importFiles, exportImage, save };
}
