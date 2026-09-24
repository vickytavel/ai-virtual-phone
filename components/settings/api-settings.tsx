"use client";

import { useState, useEffect, useCallback, useContext } from "react";
import { Plus, RefreshCw, Rss, AlertCircle, FileEdit, Trash2, X, Check } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { ApiConfig } from "@/lib/settings-types";
import { loadApiConfigs, removeApiConfigReferences, saveApiConfigs } from "@/lib/settings-storage";
import { generateEmbedding, isEmbeddingModelName } from "@/lib/memory-embedding";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { determineBaseUrl, simpleLLMCall } from "@/lib/api-helpers";

const DEFAULT_CONFIGS: ApiConfig[] = [
    {
        id: "default-openai",
        name: "OpenAI 官方",
        provider: "OpenAI",
        apiKey: "",
        defaultModel: "gpt-4o",
        enableNativeTools: true,
        enableImageRecognition: true,
        enableImageGeneration: true,
        preventEmptyGenerateRambling: true,
    }
];

function getNativeToolProtocolLabel(config: ApiConfig): string {
    if (config.provider === "Anthropic" && !config.baseUrl) return "Anthropic";
    if (config.provider === "Google") return "Gemini";
    return "OpenAI-compatible";
}

export function ApiSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Testing and Fetching states
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    const [isTesting, setIsTesting] = useState<Record<string, boolean>>({});
    // 编辑弹窗里「手动把模型名加进列表」的临时输入
    const [manualModel, setManualModel] = useState("");
    const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const loaded = loadApiConfigs();
        if (loaded.length > 0) {
            setConfigs(loaded);
        } else {
            setConfigs(DEFAULT_CONFIGS);
            saveApiConfigs(DEFAULT_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: ApiConfig[]) => {
        setConfigs(newConfigs);
        saveApiConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: ApiConfig = {
            id: `config-${Date.now()}`,
            name: "新配置",
            provider: "Custom",
            apiKey: "",
            defaultModel: "",
            enableNativeTools: true,
            enableImageRecognition: false,
            enableImageGeneration: false,
            preventEmptyGenerateRambling: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        setSubpageRightAction("api",
            <button
                onClick={addConfig}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>新增API方案</span>
            </button>
        );
        return () => setSubpageRightAction("api", null);
    }, [addConfig, setSubpageRightAction]);

    const updateConfig = (id: string, updates: Partial<ApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));
        removeApiConfigReferences(id);
        const newFetchedModels = { ...fetchedModels };
        delete newFetchedModels[id];
        setFetchedModels(newFetchedModels);

        const newTestResults = { ...testResult };
        delete newTestResults[id];
        setTestResult(newTestResults);
    };

    // Use unified determineBaseUrl from api-helpers

    const fetchModels = async (config: ApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            const baseUrl = determineBaseUrl(config);
            if (!baseUrl) throw new Error("缺少 Base URL");
            if (!config.apiKey) throw new Error("缺少 API Key");

            // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
            // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
            const isGoogleNative = config.provider === "Google";
            // 用户常把完整端点填进 Base URL（如 .../v1/embeddings、.../v1/chat/completions），
            // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
            const modelsBase = baseUrl
                .replace(/\/$/, "")
                .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
            const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
            const url = isGoogleNative
                ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
                : modelsUrl;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

            const response = await fetch(url, { method: "GET", headers });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            let modelNames: string[] = [];
            if (isGoogleNative && Array.isArray(data?.models)) {
                // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
                modelNames = data.models.map((m: { name: string }) => (m.name || "").replace(/^models\//, ""));
            } else if (Array.isArray(data?.data)) {
                modelNames = data.data.map((m: { id: string }) => m.id);
            } else {
                throw new Error("返回数据格式不符合预期");
            }
            setFetchedModels(prev => ({ ...prev, [config.id]: modelNames }));
            // 拉取成功即持久化到配置：之后无需重新拉取，直接在卡片/弹窗里切换模型
            updateConfig(config.id, { models: modelNames });
            setTestResult(prev => ({ ...prev, [config.id]: { success: true, message: `成功获取 ${modelNames.length} 个模型，已存入模型列表` } }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `拉取失败: ${msg}` } }));
            setFetchedModels(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const testConnection = async (config: ApiConfig) => {
        if (!config.defaultModel) {
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "请先输入或选择默认模型" } }));
            return;
        }

        setIsTesting(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            // 向量模型配置：测 /embeddings 端点。原来一律测 /chat/completions，
            // 导致 embedding 配置永远 404「测试失败」。
            if (isEmbeddingModelName(config.defaultModel)) {
                const embedding = await generateEmbedding("你好", config, { throwOnError: true });
                if (!embedding) throw new Error("接口未返回向量数据");
                setTestResult(prev => ({
                    ...prev,
                    [config.id]: { success: true, message: `测试成功! 向量模型可用，维度 ${embedding.length}` },
                }));
                return;
            }
            const result = await simpleLLMCall(
                config,
                [{ role: "user", content: "你好" }],
                // Cap (not spend): reasoning models (deepseek-reasoner / gemini-pro 等) burn
                // tokens on hidden reasoning first, so a tiny cap leaves the visible
                // content empty and the test falsely fails (finishReason=length).
                // 4096 covers heavy thinkers; a "你好" reply still stops well before it.
                { temperature: 0.2, max_tokens: 4096 },
            );
            if (result.error || !result.content) {
                throw new Error(result.error || "模型返回了空内容");
            }
            const reply = result.content.replace(/\s+/g, " ").trim();
            const preview = reply.length > 80 ? `${reply.slice(0, 80)}...` : reply;
            setTestResult(prev => ({
                ...prev,
                [config.id]: { success: true, message: `测试成功! 模型回复: ${preview}` },
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `测试失败: ${msg}` } }));
        } finally {
            setIsTesting(prev => ({ ...prev, [config.id]: false }));
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">API Settings</h2>
            </div>

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <AlertCircle size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有 API 配置</span>
                    <span className="menu-desc max-w-[240px]">
                        配置 API 密钥和模型以连接到 AI 服务。
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加配置
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map(config => (
                        <div
                            key={config.id}
                            className="ui-config-card min-w-0 cursor-pointer"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`编辑 ${config.name || config.provider}`}
                            onClick={() => setEditingId(config.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(config.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{config.name || config.provider}</span>
                                {(() => {
                                    const options = Array.from(new Set([
                                        ...(config.models || []),
                                        ...(config.defaultModel ? [config.defaultModel] : []),
                                    ]));
                                    // 列表里有多个可选模型时，卡片上直接给切换入口；否则显示静态模型名
                                    if (options.length > 1) {
                                        return (
                                            <select
                                                value={config.defaultModel || ""}
                                                onClick={(event) => event.stopPropagation()}
                                                onKeyDown={(event) => event.stopPropagation()}
                                                onChange={(event) => {
                                                    event.stopPropagation();
                                                    const value = event.target.value;
                                                    if (value) updateConfig(config.id, { defaultModel: value });
                                                }}
                                                className="ui-select w-full min-w-0"
                                                style={{ padding: "4px 8px", fontSize: "calc(12px*var(--app-text-scale,1))" }}
                                                aria-label={`切换 ${config.name || config.provider} 的模型`}
                                            >
                                                {!config.defaultModel && <option value="">选择模型...</option>}
                                                {options.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        );
                                    }
                                    return <span className="menu-desc truncate">{config.defaultModel || config.provider || "未设置模型"}</span>;
                                })()}
                            </div>
                            <div className="flex gap-2 shrink-0 items-center justify-end">
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setEditingId(config.id);
                                    }}
                                    className="ui-link-btn"
                                >
                                    <FileEdit size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmDeleteId(config.id);
                                    }}
                                    className="ui-link-btn"
                                    data-variant="danger"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加配置" : "编辑配置"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的 OpenAI"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={config.provider}
                                                onChange={(e) => updateConfig(config.id, { provider: e.target.value })}
                                                className="ui-select"
                                            >
                                                <option value="OpenAI">OpenAI</option>
                                                <option value="Anthropic">Anthropic</option>
                                                <option value="Google">Google Gemini</option>
                                                <option value="DeepSeek">DeepSeek</option>
                                                <option value="Groq">Groq</option>
                                                <option value="OpenRouter">OpenRouter</option>
                                                <option value="Moonshot">Kimi (Moonshot)</option>
                                                <option value="Zhipu">Zhipu (GLM)</option>
                                                <option value="SiliconFlow">SiliconFlow</option>
                                                <option value="TogetherAI">Together AI</option>
                                                <option value="Custom">自定义 (Custom)</option>
                                            </select>
                                        </div>

                                        {/* Custom 必填 Base URL；其他 provider 可选填中转站地址 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">
                                                Base URL {config.provider === "Custom" ? "（必填）" : "（可选，留空用官方端点）"}
                                                {config.provider === "Google" && (
                                                    <span style={{ color: "#888", marginLeft: 6, fontSize: "0.85em" }}>
                                                        中转站填 https://xxx/v1beta 走原生协议
                                                    </span>
                                                )}
                                            </label>
                                            <Input
                                                type="url"
                                                value={config.baseUrl || ""}
                                                onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                placeholder={
                                                    config.provider === "Custom"
                                                        ? "https://api.example.com/v1"
                                                        : config.provider === "Google"
                                                            ? "https://your-proxy.example.com/v1beta"
                                                            : "默认用官方端点，留空即可"
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="sk-..."
                                            />
                                        </div>

                                        {/* 自定义请求头：OpenCode Go 的 x-opencode-session、自建网关的额外鉴权/路由头 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">
                                                自定义请求头 (Custom Headers)
                                                <span style={{ color: "#888", marginLeft: 6, fontSize: "0.85em" }}>
                                                    可选。用于 OpenCode Go 的 x-opencode-session，或自建网关需要的额外请求头
                                                </span>
                                            </label>
                                            {(() => {
                                                const entries: [string, string][] = Object.entries(config.customHeaders || {}).map(([k, v]) => [k, String(v)]);
                                                const setEntry = (oldKey: string, newKey: string, newValue: string) => {
                                                    const next: Record<string, string> = {};
                                                    for (const [k, v] of entries) {
                                                        if (k === oldKey) {
                                                            if (newKey.trim()) next[newKey.trim()] = newValue;
                                                        } else {
                                                            next[k] = v;
                                                        }
                                                    }
                                                    updateConfig(config.id, { customHeaders: next });
                                                };
                                                const removeEntry = (key: string) => {
                                                    const next: Record<string, string> = {};
                                                    for (const [k, v] of entries) if (k !== key) next[k] = v;
                                                    updateConfig(config.id, { customHeaders: next });
                                                };
                                                const addEntry = () => {
                                                    let name = "x-opencode-session";
                                                    if (config.customHeaders && config.customHeaders[name] !== undefined) {
                                                        name = "";
                                                    }
                                                    updateConfig(config.id, { customHeaders: { ...(config.customHeaders || {}), [name]: "" } });
                                                };
                                                return (
                                                    <div className="flex flex-col gap-2">
                                                        {entries.length === 0 && (
                                                            <span className="menu-desc ml-1" style={{ opacity: 0.7 }}>
                                                                未添加。点击下方按钮可添加一条。
                                                            </span>
                                                        )}
                                                        {entries.map(([k, v]) => (
                                                            <div className="flex gap-2" key={k}>
                                                                <input
                                                                    type="text"
                                                                    value={k}
                                                                    onChange={(e) => setEntry(k, e.target.value, v)}
                                                                    placeholder="请求头名称"
                                                                    className="ui-input flex-1"
                                                                />
                                                                <input
                                                                    type="text"
                                                                    value={v}
                                                                    onChange={(e) => setEntry(k, k, e.target.value)}
                                                                    placeholder="值"
                                                                    className="ui-input flex-1"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => removeEntry(k)}
                                                                    className="ui-btn ui-btn-soft-action shrink-0"
                                                                    aria-label="删除该请求头"
                                                                >
                                                                    <Trash2 size={16} />
                                                                </button>
                                                            </div>
                                                        ))}
                                                        <button
                                                            type="button"
                                                            onClick={addEntry}
                                                            className="ui-btn ui-btn-soft-action self-start"
                                                        >
                                                            <Plus size={16} />
                                                            添加请求头
                                                        </button>
                                                    </div>
                                                );
                                            })()}
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">默认模型 (Default Model)</label>
                                            <div className="flex gap-2">
                                                {(() => {
                                                    // 已保存的模型列表 ∪ 本次会话拉取的结果（拉取成功时已持久化到 config.models）
                                                    const options = Array.from(new Set([
                                                        ...(config.models || []),
                                                        ...(fetchedModels[config.id] || []),
                                                        ...(config.defaultModel ? [config.defaultModel] : []),
                                                    ]));
                                                    if (options.length > 0) {
                                                        return (
                                                            <select
                                                                value={config.defaultModel}
                                                                onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                                className="ui-select flex-1"
                                                            >
                                                                {!config.defaultModel && <option value="">请选择模型...</option>}
                                                                {options.map(m => (
                                                                    <option key={m} value={m}>{m}</option>
                                                                ))}
                                                            </select>
                                                        );
                                                    }
                                                    return (
                                                        <input
                                                            type="text"
                                                            value={config.defaultModel}
                                                            onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                            placeholder="gpt-4o, claude-3-opus..."
                                                            className="ui-input flex-1"
                                                        />
                                                    );
                                                })()}
                                            </div>

                                            {/* 手动维护模型列表：中转站不支持 /models 时也能攒出可切换列表 */}
                                            <div className="flex gap-2 mt-1">
                                                    <input
                                                        type="text"
                                                        value={manualModel}
                                                        onChange={(e) => setManualModel(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key !== "Enter") return;
                                                            e.preventDefault();
                                                            const name = manualModel.trim();
                                                            if (!name) return;
                                                            updateConfig(config.id, {
                                                                models: Array.from(new Set([...(config.models || []), name])),
                                                                defaultModel: name,
                                                            });
                                                            setManualModel("");
                                                        }}
                                                        placeholder="手动添加模型名..."
                                                        className="ui-input flex-1"
                                                    />
                                                    <button
                                                        type="button"
                                                        className="ui-btn ui-btn-soft-action shrink-0"
                                                        onClick={() => {
                                                            const name = manualModel.trim();
                                                            if (!name) return;
                                                            updateConfig(config.id, {
                                                                models: Array.from(new Set([...(config.models || []), name])),
                                                                defaultModel: name,
                                                            });
                                                            setManualModel("");
                                                        }}
                                                    >
                                                        加入列表
                                                    </button>
                                                </div>
                                            <span className="menu-desc ml-1" style={{ opacity: 0.7 }}>
                                                「拉取模型列表」会把该链接下的模型存进来；之后在配置卡片上即可直接切换模型，无需复制多份配置。
                                            </span>
                                        </div>

                                        <div className="flex gap-3 mt-1">
                                            <button
                                                onClick={() => fetchModels(config)}
                                                disabled={isFetching[config.id]}
                                                className="ui-btn ui-btn ui-btn-soft-action flex-1"
                                            >
                                                <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                {isFetching[config.id] ? "拉取中..." : "拉取模型列表"}
                                            </button>

                                            <button
                                                onClick={() => testConnection(config)}
                                                disabled={isTesting[config.id]}
                                                className="ui-btn ui-btn ui-btn-success flex-1"
                                            >
                                                <Rss size={16} className={isTesting[config.id] ? "animate-spin" : ""} />
                                                {isTesting[config.id] ? "测试中..." : "测试连接"}
                                            </button>
                                        </div>

                                        {testResult[config.id] && testResult[config.id].message && (
                                            <Alert variant={testResult[config.id].success ? "success" : "danger"}>
                                                <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                                <span className="break-all leading-[1.5]">{testResult[config.id].message}</span>
                                            </Alert>
                                        )}

                                        <div
                                            className="ui-toggle-row mt-2 overflow-visible"
                                            style={{ display: "block", position: "relative", height: "auto", flexShrink: 0, padding: "14px 76px 14px 16px" }}
                                        >
                                            <span className="menu-label font-medium">启用原生工具调用</span>
                                            <span className="menu-desc whitespace-normal break-words leading-[1.45]">
                                                开启后自动选择该服务商可用的原生工具格式（当前：{getNativeToolProtocolLabel(config)}）；关闭后使用文本动作协议。
                                            </span>
                                            <span style={{ position: "absolute", top: 0, bottom: 0, right: 16, display: "flex", alignItems: "center" }}>
                                                <Toggle
                                                    checked={config.enableNativeTools !== false}
                                                    onChange={(v) => updateConfig(config.id, { enableNativeTools: v })}
                                                />
                                            </span>
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="menu-label font-medium">启用图像识别</span>
                                            <Toggle checked={config.enableImageRecognition} onChange={(v) => updateConfig(config.id, { enableImageRecognition: v })} />
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="flex min-w-0 flex-col">
                                                <span className="menu-label font-medium">防胡言乱语</span>
                                                <span className="menu-desc">防止没有用户输入时胡言乱语</span>
                                            </span>
                                            <Toggle
                                                checked={config.preventEmptyGenerateRambling === true}
                                                onChange={(v) => updateConfig(config.id, { preventEmptyGenerateRambling: v })}
                                            />
                                        </div>

                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}

