import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthProvider";
import {
    deleteGalleryImage,
    fetchGalleryBlob,
    fetchGalleryPage,
    type PublicGalleryImage,
} from "../lib/galleryApi";
import { adminRevokeGalleryImage } from "../lib/notificationApi";
import { formatTimestamp } from "../lib/format";
import {
    openDestructiveConfirm,
    openPromptDialog,
    showAppToast,
} from "../lib/dialog";
import { getUserFacingErrorMessage } from "../lib/userFacingText";
import { useAsyncQuery } from "../hooks/useAsyncQuery";
import PanelShell from "./PanelShell";
import ModalShell from "./ModalShell";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

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
}: {
    src: string;
    alt?: string;
    className?: string;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<"loading" | "loaded" | "error">(
        "loading",
    );
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        let aborted = false;
        let objectUrl: string | null = null;
        setStatus("loading");
        fetchGalleryBlob(src)
            .then((blob) => {
                if (aborted) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            })
            .catch((err) => {
                if (aborted) return;
                console.error("[AuthImage] fetch failed:", src, err);
                setStatus("error");
            });
        return () => {
            aborted = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [src, retryKey]);

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
                className={`flex items-center justify-center bg-[hsl(var(--muted))] ${className ?? ""}`}
            >
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
            </div>
        );
    }

    return (
        <img
            src={url}
            alt={alt}
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
    title = "公开画廊",
}: Props) {
    const [page, setPage] = useState(0);
    const [detail, setDetail] = useState<PublicGalleryImage | null>(null);
    // 详情大图当前展示的图片 id：默认结果图，点参考图缩略图可切到对应原图
    const [activeImageId, setActiveImageId] = useState<string | null>(null);
    const detailScrollRef = useRef<HTMLDivElement>(null);
    const { user, refresh } = useAuth();

    const { data, loading, error, reload } = useAsyncQuery(
        () => fetchGalleryPage(PAGE_SIZE, page * PAGE_SIZE, userId),
        [page, userId],
        open,
    );

    const images = data?.images ?? [];
    const total = data?.total ?? 0;
    const maxPage = useMemo(
        () => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1),
        [total],
    );

    useEffect(() => {
        if (open) setPage(0);
    }, [open, userId]);

    // 切换/关闭详情时，大图回到结果图
    useEffect(() => {
        setActiveImageId(null);
    }, [detail?.id]);

    function deleteImage(id: string) {
        openDestructiveConfirm({
            title: "删除公开图",
            message:
                "确定删除这张公开图吗？删除后其他成员将无法在画廊中看到它。",
            onConfirm: async () => {
                try {
                    await deleteGalleryImage(id);
                    if (detail?.id === id) setDetail(null);
                    await reload();
                    await refresh();
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
                    if (detail?.id === img.id) setDetail(null);
                    await reload();
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
                    {loading && (
                        <p className="text-sm text-[hsl(var(--muted-foreground))]">
                            加载中…
                        </p>
                    )}
                    {error && (
                        <p className="text-sm text-red-500">
                            {getUserFacingErrorMessage(
                                error,
                                "加载公开画廊失败",
                            )}
                        </p>
                    )}
                    {!loading && !error && images.length === 0 && (
                        <p className="py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
                            {userId
                                ? "你还没有共享图片。"
                                : '还没有公开图。生成图片后点"公开到画廊"上传。'}
                        </p>
                    )}
                    {!loading && !error && images.length > 0 && (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                            {images.map((img) => (
                                <button
                                    key={img.id}
                                    type="button"
                                    onClick={() => setDetail(img)}
                                    className="group relative overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] aspect-square"
                                >
                                    <AuthImage
                                        src={`/api/gallery/image/${img.id}?thumb=1`}
                                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                                    />
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

                    {maxPage > 0 && (
                        <div className="mt-6 flex items-center justify-between text-sm">
                            <span className="text-[hsl(var(--muted-foreground))]">
                                共 {total} 张 · 第 {page + 1} / {maxPage + 1} 页
                            </span>
                            <div className="flex gap-2">
                                <button
                                    disabled={page === 0}
                                    onClick={() =>
                                        setPage((p) => Math.max(0, p - 1))
                                    }
                                    className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50"
                                >
                                    上一页
                                </button>
                                <button
                                    disabled={page >= maxPage}
                                    onClick={() =>
                                        setPage((p) => Math.min(maxPage, p + 1))
                                    }
                                    className="rounded border border-[hsl(var(--border))] px-3 py-1 disabled:opacity-50"
                                >
                                    下一页
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </PanelShell>

            {detail && (
                <ModalShell
                    portal
                    onClose={() => setDetail(null)}
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
                    <div ref={detailScrollRef} className="flex w-full shrink-0 flex-col gap-3 p-6 md:shrink md:overflow-y-auto md:w-80">
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
                                onClick={() => setDetail(null)}
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
                        {user && detail.user_id === user.userId && (
                            <button
                                onClick={() => void deleteImage(detail.id)}
                                className="mt-auto rounded bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
                            >
                                删除
                            </button>
                        )}
                        {user &&
                            user.isAdmin &&
                            detail.user_id !== user.userId && (
                                <button
                                    onClick={() => revokeImage(detail)}
                                    className="mt-auto rounded border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-600 hover:bg-red-500/20 dark:text-red-400"
                                    title="以管理员身份撤下，并向作者发送通知"
                                >
                                    撤下（管理员）
                                </button>
                            )}
                    </div>
                </ModalShell>
            )}
        </>
    );
}
