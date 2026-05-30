import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../contexts/AuthProvider";
import {
    deleteGalleryImage,
    fetchGalleryBlob,
    fetchGalleryPage,
    type PublicGalleryImage,
} from "../lib/galleryApi";
import { adminRevokeGalleryImage, adminSetGalleryFeatured } from "../lib/notificationApi";
import { downloadGalleryImage } from "../lib/downloadGallery";
import { formatTimestamp } from "../lib/format";
import {
    openDestructiveConfirm,
    openPromptDialog,
    showAppToast,
} from "../lib/dialog";
import { getUserFacingErrorMessage } from "../lib/userFacingText";
import { useCloseOnEscape } from "../hooks/useCloseOnEscape";
import PanelShell from "./PanelShell";
import ModalShell from "./ModalShell";
import Avatar from "./Avatar";
import { CloseIcon, DownloadIcon, ThumbUpIcon, TrashIcon } from "./icons";

const PAGE_SIZE = 24;

interface Props {
    open: boolean;
    onClose: () => void;
    userId?: string;
    title?: string;
}

function AuthImage({
    src,
    alt,
    className,
    lazy = false,
}: {
    src: string;
    alt?: string;
    className?: string;
    lazy?: boolean;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
        lazy ? "idle" : "loading",
    );
    const [retryKey, setRetryKey] = useState(0);
    // 懒加载 + 有限内存：只保留视口附近（上下各 600px）范围内的缩略图 blob。
    // 进入该范围才下载，滚远后释放对象 URL 回收解码内存；滚回来时再取——
    // 命中浏览器对缩略图的 immutable 缓存，几乎不产生新网络请求。
    const [near, setNear] = useState(!lazy);
    const observerRef = useRef<IntersectionObserver | null>(null);

    // callback ref 挂在当前渲染的元素（占位 / <img>）上，元素切换时自动重连 observer
    const setNode = useCallback(
        (node: HTMLElement | null) => {
            observerRef.current?.disconnect();
            observerRef.current = null;
            if (!lazy) return;
            if (!node || typeof IntersectionObserver === "undefined") {
                setNear(true);
                return;
            }
            const observer = new IntersectionObserver(
                (entries) => setNear(entries[entries.length - 1].isIntersecting),
                { rootMargin: "600px" },
            );
            observer.observe(node);
            observerRef.current = observer;
        },
        [lazy],
    );

    useEffect(() => {
        if (!near || status === "error") return;
        let aborted = false;
        let objectUrl: string | null = null;
        setStatus("loading");
        fetchGalleryBlob(src)
            .then((blob) => {
                if (aborted) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
                setStatus("loaded");
            })
            .catch((err) => {
                if (aborted) return;
                console.error("[AuthImage] fetch failed:", src, err);
                setStatus("error");
            });
        // 离开视口范围 / 切换 src / 卸载时：中止并释放 blob，回到占位
        return () => {
            aborted = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            setUrl(null);
        };
    }, [near, src, retryKey]);

    function retry() {
        setUrl(null);
        setStatus("loading");
        setRetryKey((k) => k + 1);
    }

    if (status === "error") {
        return (
            <div
                className={`flex flex-col items-center justify-center gap-2 bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] ${className ?? ""}`}
            >
                <span className="text-xs">加载失败</span>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        retry();
                    }}
                    className="rounded border border-[hsl(var(--border))] px-2 py-0.5 text-xs hover:bg-[hsl(var(--background))]"
                >
                    重试
                </button>
            </div>
        );
    }

    if (!url) {
        return (
            <div
                ref={setNode}
                className={`flex items-center justify-center bg-[hsl(var(--muted))] ${className ?? ""}`}
            >
                {status === "loading" && (
                    <svg
                        className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                        />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                    </svg>
                )}
            </div>
        );
    }

    return (
        <img
            ref={setNode}
            src={url}
            alt={alt}
            decoding="async"
            className={className}
            onError={() => {
                console.error("[AuthImage] <img> load failed:", src);
                setStatus("error");
            }}
            onLoad={() => setStatus("loaded")}
        />
    );
}

function getGalleryDisplayName(img: PublicGalleryImage): string {
    return img.display_name || img.username;
}

export default function GalleryView({
    open,
    onClose,
    userId,
    title = "共享画廊",
}: Props) {
    const [images, setImages] = useState<PublicGalleryImage[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const [loadedOnce, setLoadedOnce] = useState(false);
    // 详情弹窗只持有 id，详情对象从 images 派生，使 images 成为唯一数据源：
    // 推荐 / 删除 / 撤下只改 images 一处，弹窗自动跟随；被移除时 detail 变 null 自动关闭。
    const [detailId, setDetailId] = useState<string | null>(null);
    // 详情大图当前展示的图片 id：默认结果图，点参考图缩略图可切到对应原图
    const [activeImageId, setActiveImageId] = useState<string | null>(null);
    // 卡片右键菜单
    const [menu, setMenu] = useState<{ img: PublicGalleryImage; x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const detailScrollRef = useRef<HTMLDivElement>(null);
    const { user, patchUser } = useAuth();

    const detail = useMemo(
        () => images.find((it) => it.id === detailId) ?? null,
        [images, detailId],
    );

    // Esc 关闭右键菜单（注册在全局 ESC 栈顶，先于画廊面板，避免误关整个画廊）
    useCloseOnEscape(Boolean(menu), () => setMenu(null));

    // 点击别处 / 滚动 / 缩放时关闭右键菜单（点菜单内部不关）
    useEffect(() => {
        if (!menu) return;
        const close = (e: Event) => {
            if (
                e.target instanceof Node &&
                menuRef.current?.contains(e.target)
            ) {
                return;
            }
            setMenu(null);
        };
        window.addEventListener("mousedown", close, { capture: true });
        window.addEventListener("wheel", close, { capture: true });
        window.addEventListener("scroll", close, { capture: true });
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("mousedown", close, { capture: true });
            window.removeEventListener("wheel", close, { capture: true });
            window.removeEventListener("scroll", close, { capture: true });
            window.removeEventListener("resize", close);
        };
    }, [menu]);

    async function downloadImage(id: string) {
        try {
            await downloadGalleryImage(id);
        } catch (e) {
            showAppToast(
                getUserFacingErrorMessage(e, "下载图片失败"),
                "error",
            );
        }
    }

    // 无限滚动：累加分页结果，滚动到底部哨兵附近时拉取下一页。
    // 用 ref 同步最新进度，让 loadMore 保持稳定身份；epoch 让重置后丢弃在途的旧请求。
    const loadingRef = useRef(false);
    const epochRef = useRef(0);
    const progressRef = useRef({ count: 0, total: 0, loadedOnce: false });
    progressRef.current = { count: images.length, total, loadedOnce };

    const hasMore = !loadedOnce || images.length < total;

    const loadMore = useCallback(async () => {
        if (loadingRef.current) return;
        const { count, total: loadedTotal, loadedOnce: done } = progressRef.current;
        if (done && count >= loadedTotal) return;
        loadingRef.current = true;
        const epoch = epochRef.current;
        setLoading(true);
        setError(null);
        try {
            const data = await fetchGalleryPage(PAGE_SIZE, count, userId);
            if (epoch !== epochRef.current) return; // 已重置，丢弃旧结果
            setTotal(data.total);
            setImages((prev) => {
                const seen = new Set(prev.map((it) => it.id));
                const merged = [...prev];
                for (const img of data.images) {
                    if (!seen.has(img.id)) {
                        seen.add(img.id);
                        merged.push(img);
                    }
                }
                return merged;
            });
            setLoadedOnce(true);
        } catch (e) {
            if (epoch === epochRef.current) setError(e);
        } finally {
            if (epoch === epochRef.current) {
                loadingRef.current = false;
                setLoading(false);
            }
        }
    }, [userId]);

    // 打开或切换用户时重置并加载首页
    useEffect(() => {
        if (!open) return;
        epochRef.current += 1;
        loadingRef.current = false;
        progressRef.current = { count: 0, total: 0, loadedOnce: false };
        setImages([]);
        setTotal(0);
        setLoadedOnce(false);
        setError(null);
        void loadMore();
    }, [open, userId, loadMore]);

    // 底部哨兵进入视口附近时加载下一页（用 callback ref 以便哨兵增删时自动重连）
    const observerRef = useRef<IntersectionObserver | null>(null);
    const sentinelRef = useCallback(
        (node: HTMLDivElement | null) => {
            observerRef.current?.disconnect();
            observerRef.current = null;
            if (!node || typeof IntersectionObserver === "undefined") return;
            const observer = new IntersectionObserver(
                (entries) => {
                    if (entries.some((entry) => entry.isIntersecting)) {
                        void loadMore();
                    }
                },
                { rootMargin: "400px" },
            );
            observer.observe(node);
            observerRef.current = observer;
        },
        // images.length 变化时重建 observer：新内容加载后若哨兵仍在视口内，
        // IntersectionObserver 会在 observe 时立即回调，从而继续填满首屏、避免卡住。
        [loadMore, images.length],
    );

    function removeImage(id: string) {
        setImages((prev) => prev.filter((it) => it.id !== id));
        setTotal((t) => Math.max(0, t - 1));
    }

    async function toggleFeatured(img: PublicGalleryImage) {
        const next = !(img.featured);
        try {
            await adminSetGalleryFeatured(img.id, next);
            setImages((prev) =>
                prev.map((it) =>
                    it.id === img.id ? { ...it, featured: next ? 1 : 0 } : it,
                ),
            );
            showAppToast(next ? "已设为推荐" : "已取消推荐", "success");
        } catch (e) {
            showAppToast(getUserFacingErrorMessage(e, "设置推荐失败"), "error");
        }
    }

    // 切换/关闭详情时，大图回到结果图
    useEffect(() => {
        setActiveImageId(null);
    }, [detailId]);

    function deleteImage(id: string) {
        openDestructiveConfirm({
            title: "删除公开图",
            message:
                "确定删除这张公开图吗？删除后其他成员将无法在画廊中看到它。",
            onConfirm: async () => {
                try {
                    const res = await deleteGalleryImage(id);
                    if (detailId === id) setDetailId(null);
                    removeImage(id);
                    // 用删除接口回传的占用 / 张数本地更新，省去整轮 /api/me 刷新
                    patchUser({
                        publicStorageBytes: res.storageBytes,
                        publicGalleryCount: res.galleryCount,
                    });
                } catch (e) {
                    showAppToast(
                        getUserFacingErrorMessage(e, "删除公开图失败"),
                        "error",
                    );
                }
            },
        });
    }

    function revokeImage(img: PublicGalleryImage) {
        const ownerLabel = getGalleryDisplayName(img);
        openPromptDialog({
            title: "撤下公开图",
            message: `将「${ownerLabel}」的这张公开图从画廊撤下，并向作者发送通知。\n可填写撤下理由（选填，将一并展示给作者）。`,
            inputType: "text",
            placeholder: "例如：内容不符合社区规范",
            confirmText: "撤下",
            validate: (v) =>
                v.length > 500 ? "理由请控制在 500 字以内。" : null,
            onConfirm: async (reason) => {
                try {
                    await adminRevokeGalleryImage(
                        img.id,
                        reason.trim() || undefined,
                    );
                    if (detailId === img.id) setDetailId(null);
                    removeImage(img.id);
                    showAppToast("已撤下并通知作者。", "success");
                } catch (e) {
                    showAppToast(
                        getUserFacingErrorMessage(e, "撤下公开图失败"),
                        "error",
                    );
                }
            },
        });
    }

    return (
        <>
            <PanelShell open={open} onClose={onClose} title={title}>
                <div className="flex-1 overflow-y-auto p-6">
                    {loading && images.length === 0 && (
                        <p className="text-sm text-[hsl(var(--muted-foreground))]">
                            加载中…
                        </p>
                    )}
                    {Boolean(error) && images.length === 0 && (
                        <div className="space-y-2">
                            <p className="text-sm text-red-500">
                                {getUserFacingErrorMessage(
                                    error,
                                    "加载共享画廊失败",
                                )}
                            </p>
                            <button
                                type="button"
                                onClick={() => void loadMore()}
                                className="rounded border border-[hsl(var(--border))] px-3 py-1 text-sm hover:bg-[hsl(var(--muted))]"
                            >
                                重试
                            </button>
                        </div>
                    )}
                    {loadedOnce &&
                        !loading &&
                        !error &&
                        images.length === 0 && (
                            <p className="py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
                                {userId
                                    ? "你还没有共享图片。"
                                    : '还没有公开图。生成图片后点"公开到画廊"上传。'}
                            </p>
                        )}
                    {images.length > 0 && (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                            {images.map((img) => (
                                <button
                                    key={img.id}
                                    type="button"
                                    onClick={() => setDetailId(img.id)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setMenu({
                                            img,
                                            x: e.clientX,
                                            y: e.clientY,
                                        });
                                    }}
                                    className="group relative overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] aspect-square cv-auto"
                                >
                                    <AuthImage
                                        lazy
                                        src={`/api/gallery/image/${img.id}?thumb=1`}
                                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                                    />
                                    {Boolean(img.featured) && (
                                        <span
                                            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/90 text-white shadow-sm ring-1 ring-white/40 backdrop-blur-sm"
                                            title="管理员推荐"
                                            aria-label="管理员推荐"
                                        >
                                            <ThumbUpIcon className="h-3.5 w-3.5" />
                                        </span>
                                    )}
                                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent p-2">
                                        <Avatar
                                            userId={img.user_id}
                                            username={getGalleryDisplayName(
                                                img,
                                            )}
                                            avatarUpdatedAt={
                                                img.avatar_updated_at
                                            }
                                            size={20}
                                            className="shrink-0 ring-1 ring-white/30"
                                        />
                                        <p className="truncate text-xs text-white">
                                            {getGalleryDisplayName(img)}
                                        </p>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}

                    {images.length > 0 && (
                        <div className="mt-6 flex flex-col items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                            {hasMore && (
                                <div ref={sentinelRef} className="h-px w-full" />
                            )}
                            {loading && hasMore && (
                                <span className="flex items-center gap-2">
                                    <svg
                                        className="h-4 w-4 animate-spin"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                    >
                                        <circle
                                            className="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            strokeWidth="4"
                                        />
                                        <path
                                            className="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                        />
                                    </svg>
                                    加载中…
                                </span>
                            )}
                            {Boolean(error) && !loading && (
                                <button
                                    type="button"
                                    onClick={() => void loadMore()}
                                    className="rounded border border-[hsl(var(--border))] px-3 py-1 hover:bg-[hsl(var(--muted))]"
                                >
                                    加载失败，点击重试
                                </button>
                            )}
                            {!hasMore && <span>共 {total} 张，已全部加载</span>}
                        </div>
                    )}
                </div>
            </PanelShell>

            {detail && (
                <ModalShell
                    portal
                    onClose={() => setDetailId(null)}
                    scrollRef={detailScrollRef}
                    zIndexClass="z-50"
                    backdropClassName="bg-black/60"
                    panelClassName="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-y-auto rounded-2xl bg-white shadow-2xl dark:bg-[hsl(240_10%_12%)] md:flex-row md:overflow-hidden"
                >
                    <div className="relative flex shrink-0 items-center justify-center bg-black p-4 md:flex-1">
                        <AuthImage
                            key={activeImageId ?? detail.id}
                            src={`/api/gallery/image/${activeImageId ?? detail.id}`}
                            className="max-h-[60vh] max-w-full object-contain md:max-h-[80vh]"
                        />
                        {activeImageId && (
                            <button
                                type="button"
                                onClick={() => setActiveImageId(null)}
                                className="absolute left-4 top-4 rounded bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm transition hover:bg-black/70"
                            >
                                参考图 · 点击返回结果
                            </button>
                        )}
                    </div>
                    <div ref={detailScrollRef} className="flex w-full shrink-0 flex-col gap-3 overscroll-contain p-6 md:max-h-[90vh] md:min-h-0 md:shrink md:overflow-y-auto md:w-80">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <Avatar
                                    userId={detail.user_id}
                                    username={getGalleryDisplayName(detail)}
                                    avatarUpdatedAt={detail.avatar_updated_at}
                                    size={28}
                                    className="shrink-0"
                                />
                                <p className="truncate text-sm font-medium text-[hsl(var(--foreground))]">
                                    {getGalleryDisplayName(detail)}
                                </p>
                            </div>
                            <button
                                onClick={() => setDetailId(null)}
                                className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
                            >
                                <CloseIcon className="h-4 w-4" />
                            </button>
                        </div>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">
                            {formatTimestamp(detail.created_at)}
                        </p>
                        {detail.width && detail.height && (
                            <p className="text-xs text-[hsl(var(--muted-foreground))]">
                                {detail.width}×{detail.height}
                            </p>
                        )}
                        <div>
                            <p className="mb-1 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                提示词
                            </p>
                            <p className="whitespace-pre-wrap rounded bg-[hsl(var(--muted))] p-3 text-sm text-[hsl(var(--foreground))]">
                                {detail.prompt}
                            </p>
                        </div>
                        {detail.originals && detail.originals.length > 0 && (
                            <div>
                                <p className="mb-2 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                    参考图
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {detail.originals.map((orig) => (
                                        <button
                                            key={orig.id}
                                            type="button"
                                            onClick={() => setActiveImageId(orig.id)}
                                            className={`h-16 w-16 overflow-hidden rounded-lg border bg-[hsl(var(--muted))] transition hover:opacity-80 ${
                                                activeImageId === orig.id
                                                    ? "border-2 border-blue-500 shadow-sm"
                                                    : "border-[hsl(var(--border))]"
                                            }`}
                                            title="查看参考图大图"
                                        >
                                            <AuthImage
                                                src={`/api/gallery/image/${orig.id}?thumb=1`}
                                                className="h-full w-full object-cover"
                                            />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {(Boolean(user?.isAdmin) ||
                            (user && detail.user_id === user.userId)) && (
                            <div className="mt-auto flex flex-col gap-2 pt-2">
                                {user?.isAdmin && (
                                    <button
                                        onClick={() => void toggleFeatured(detail)}
                                        className={`flex items-center justify-center gap-1.5 rounded px-4 py-2 text-sm transition ${
                                            detail.featured
                                                ? "border border-rose-500/50 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
                                                : "border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
                                        }`}
                                        title="管理员推荐：置顶并在缩略图上显示点赞图案"
                                    >
                                        <ThumbUpIcon className="h-4 w-4" />
                                        {detail.featured ? "取消推荐" : "设为推荐"}
                                    </button>
                                )}
                                {user && detail.user_id === user.userId && (
                                    <button
                                        onClick={() => void deleteImage(detail.id)}
                                        className="rounded bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
                                    >
                                        删除
                                    </button>
                                )}
                                {user &&
                                    user.isAdmin &&
                                    detail.user_id !== user.userId && (
                                        <button
                                            onClick={() => revokeImage(detail)}
                                            className="rounded border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-600 hover:bg-red-500/20 dark:text-red-400"
                                            title="以管理员身份撤下，并向作者发送通知"
                                        >
                                            撤下（管理员）
                                        </button>
                                    )}
                            </div>
                        )}
                    </div>
                </ModalShell>
            )}

            {menu &&
                createPortal(
                    (() => {
                        const isOwner = Boolean(
                            user && menu.img.user_id === user.userId,
                        );
                        const isAdminOther = Boolean(
                            user &&
                                user.isAdmin &&
                                menu.img.user_id !== user.userId,
                        );
                        const isAdmin = Boolean(user?.isAdmin);
                        const MENU_W = 160;
                        const itemCount =
                            1 + (isOwner || isAdminOther ? 1 : 0) + (isAdmin ? 1 : 0);
                        const MENU_H = 8 + itemCount * 38;
                        const left = Math.max(
                            8,
                            Math.min(menu.x, window.innerWidth - MENU_W - 8),
                        );
                        const top = Math.max(
                            8,
                            Math.min(menu.y, window.innerHeight - MENU_H - 8),
                        );
                        return (
                            <div
                                ref={menuRef}
                                className="fixed z-[9999] min-w-[150px] overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800 animate-fade-in"
                                style={{ left, top }}
                                onContextMenu={(e) => e.preventDefault()}
                            >
                                <button
                                    type="button"
                                    onClick={() => {
                                        const id = menu.img.id;
                                        setMenu(null);
                                        void downloadImage(id);
                                    }}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
                                >
                                    <DownloadIcon className="h-4 w-4 shrink-0" />
                                    下载
                                </button>
                                {isAdmin && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const img = menu.img;
                                            setMenu(null);
                                            void toggleFeatured(img);
                                        }}
                                        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
                                    >
                                        <ThumbUpIcon className="h-4 w-4 shrink-0" />
                                        {menu.img.featured ? "取消推荐" : "设为推荐"}
                                    </button>
                                )}
                                {isOwner && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const id = menu.img.id;
                                            setMenu(null);
                                            deleteImage(id);
                                        }}
                                        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                                    >
                                        <TrashIcon className="h-4 w-4 shrink-0" />
                                        删除
                                    </button>
                                )}
                                {!isOwner && isAdminOther && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const img = menu.img;
                                            setMenu(null);
                                            revokeImage(img);
                                        }}
                                        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                                        title="以管理员身份撤下，并向作者发送通知"
                                    >
                                        <TrashIcon className="h-4 w-4 shrink-0" />
                                        撤下（管理员）
                                    </button>
                                )}
                            </div>
                        );
                    })(),
                    document.body,
                )}
        </>
    );
}
