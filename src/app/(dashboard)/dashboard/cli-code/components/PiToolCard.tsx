"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import CliStatusBadge from "./CliStatusBadge";
import { useTranslations } from "next-intl";
import { DEFAULT_DISPLAY_BASE_URL } from "@/shared/hooks";

/** Pi loads this provider with its OpenAI-compatible transport. */
const PI_PROVIDER_API = "openai-completions";

/** Pi requires an explicit `/v1` suffix on OmniRoute's base URL. */
function ensurePiV1BaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Pi Coding Agent integration card.
 *
 * Pi loads custom providers from `~/.pi/agent/models.json` (relocatable with
 * `PI_CODING_AGENT_DIR`). OmniRoute registers itself as an `openai-completions`
 * provider named `omniroute` with an explicit model list — Pi never auto-lists
 * models for custom endpoints.
 */
export default function PiToolCard({
  tool,
  isExpanded = false,
  onToggle = () => {},
  baseUrl,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  batchStatus,
  lastConfiguredAt,
}) {
  const t = useTranslations("cliTools");
  const [piStatus, setPiStatus] = useState(null);
  const [checkingPi, setCheckingPi] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKeyId, setSelectedApiKeyId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [endpointUrl, setEndpointUrl] = useState(baseUrl || DEFAULT_DISPLAY_BASE_URL);
  const [modalOpen, setModalOpen] = useState(false);
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const hasInitializedModel = useRef(false);
  const hasInitializedEndpoint = useRef(false);
  const [backups, setBackups] = useState([]);
  const [showBackups, setShowBackups] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(null);
  const cliReady = !!(piStatus?.installed && piStatus?.runnable);

  const getConfigStatus = () => {
    if (!cliReady) return null;
    if (!piStatus.hasOmniRoute) return "not_configured";
    return "configured";
  };

  const configStatus = getConfigStatus();
  const effectiveConfigStatus = configStatus || batchStatus?.configStatus || null;
  // Only offer Reset for an entry OmniRoute owns; a hand-edited provider that
  // merely points at this instance is not ours to delete.
  const canReset = configStatus === "configured" && piStatus.omniRouteOwned !== false;

  // (#523) Store the key *id* (not the masked string) so the backend resolves
  // the real secret from the DB before writing it to models.json.
  const effectiveApiKeyId = selectedApiKeyId || (apiKeys?.length > 0 ? apiKeys[0].id : "");

  const fetchBackups = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/backups?tool=pi");
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const checkPiStatus = useCallback(async () => {
    setCheckingPi(true);
    try {
      const res = await fetch("/api/cli-tools/pi-settings");
      const data = await res.json();
      setPiStatus(data);
      // Sync the local model field with whatever is already configured so the
      // card opens showing the live value instead of a blank input.
      if (data.model && !hasInitializedModel.current) {
        setSelectedModel(data.model);
        hasInitializedModel.current = true;
      }
      if (data.baseUrl && !hasInitializedEndpoint.current) {
        setEndpointUrl(data.baseUrl);
        hasInitializedEndpoint.current = true;
      }
    } catch (error) {
      setPiStatus({ error: error.message });
    } finally {
      setCheckingPi(false);
    }
  }, []);

  useEffect(() => {
    if (!(isExpanded && !piStatus)) return;
    // Async continuation so every setState happens after an await
    // (react-hooks/set-state-in-effect: no synchronous setState in effects).
    void (async () => {
      await Promise.all([checkPiStatus(), fetchBackups()]);
    })();
  }, [isExpanded, piStatus, checkPiStatus, fetchBackups]);

  const handleRestoreBackup = async (backupId) => {
    setRestoringBackup(backupId);
    try {
      const res = await fetch("/api/cli-tools/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "pi", backupId }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: t("backupRestoredReloading") });
        await checkPiStatus();
        await fetchBackups();
      } else {
        const data = await res.json();
        setMessage({
          type: "error",
          text:
            (typeof data.error === "string" ? data.error : data.error?.message) ||
            t("failedRestoreBackup"),
        });
      }
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setRestoringBackup(null);
    }
  };

  const getEffectiveBaseUrl = () => {
    return endpointUrl || baseUrl || DEFAULT_DISPLAY_BASE_URL;
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const effectiveBaseUrl = getEffectiveBaseUrl();
      const normalizedBaseUrl = ensurePiV1BaseUrl(effectiveBaseUrl);

      const selectedKeyId = effectiveApiKeyId?.trim() || null;

      const res = await fetch("/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: normalizedBaseUrl,
          apiKey: !cloudEnabled ? "sk_omniroute" : null,
          keyId: selectedKeyId,
          model: selectedModel,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || t("applied") });
        await checkPiStatus();
        await fetchBackups();
      } else {
        setMessage({
          type: "error",
          text: (typeof data.error === "string" ? data.error : data.error?.message) || t("failed"),
          containerEphemeralTarget: Boolean(data.containerEphemeralTarget),
        });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/pi-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || t("resetDone") });
        setSelectedModel("");
        hasInitializedModel.current = false;
        await checkPiStatus();
        await fetchBackups();
      } else {
        setMessage({
          type: "error",
          text: (typeof data.error === "string" ? data.error : data.error?.message) || t("failed"),
        });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleSelectModel = (model) => {
    setSelectedModel(model.value);
    setModalOpen(false);
  };

  const getManualConfigs = () => {
    const apiKeyHint = apiKeys?.find((k) => k.id === effectiveApiKeyId)?.key;
    return [
      {
        filename: piStatus?.modelsPath || "~/.pi/agent/models.json",
        content: JSON.stringify(
          {
            providers: {
              omniroute: {
                baseUrl: ensurePiV1BaseUrl(getEffectiveBaseUrl()),
                api: PI_PROVIDER_API,
                apiKey: apiKeyHint || "<API_KEY_FROM_DASHBOARD>",
                omnirouteManaged: true,
                models: selectedModel ? [{ id: selectedModel, name: selectedModel }] : [],
              },
            },
          },
          null,
          2
        ),
      },
    ];
  };

  // models.json the user (or another tool) hand-edited into something Pi
  // cannot load. Show the reason instead of pretending it is merely empty.
  const configError = piStatus?.configError;

  return (
    <Card padding="sm" className="overflow-hidden">
      <div className="flex items-center justify-between hover:cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg flex items-center justify-center shrink-0">
            {tool.image ? (
              <Image
                src={tool.image}
                alt={tool.name}
                width={32}
                height={32}
                className="size-8 object-contain rounded-lg"
                sizes="32px"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = "none";
                }}
              />
            ) : (
              <span className="material-symbols-outlined text-xl" style={{ color: tool.color }}>
                terminal
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              <CliStatusBadge
                effectiveConfigStatus={effectiveConfigStatus}
                batchStatus={batchStatus}
                lastConfiguredAt={lastConfiguredAt}
              />
            </div>
            <p className="text-xs text-text-muted truncate">{t("toolDescriptions.pi")}</p>
          </div>
        </div>
        <span
          className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}
        >
          expand_more
        </span>
      </div>

      {isExpanded && (
        <div className="mt-6 pt-6 border-t border-border">
          {checkingPi && (
            <div className="flex items-center gap-2 text-text-muted text-sm">
              <span className="material-symbols-outlined animate-spin text-base">
                progress_activity
              </span>
              <span>{t("checkingCli", { tool: "Pi" })}</span>
            </div>
          )}

          {piStatus && !checkingPi && (
            <div className="flex flex-col gap-4">
              {/* Runtime status */}
              <div className="flex items-start gap-3 p-3 rounded-lg border bg-bg-secondary/50 border-border">
                <span
                  className={`material-symbols-outlined text-lg ${cliReady ? "text-green-500" : "text-yellow-500"}`}
                >
                  {cliReady ? "check_circle" : "warning"}
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">
                    {cliReady
                      ? t("cliDetectedReady", { tool: "Pi" })
                      : piStatus.installed
                        ? t("cliNotRunnable", { tool: "Pi" })
                        : t("cliNotDetected", { tool: "Pi" })}
                  </p>
                  {piStatus.commandPath && (
                    <p className="text-xs text-text-muted">
                      {t("binary")}:{" "}
                      <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">
                        {piStatus.commandPath}
                      </code>
                    </p>
                  )}
                  {piStatus.modelsPath && (
                    <p className="text-xs text-text-muted">
                      {t("configPath")}:{" "}
                      <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">
                        {piStatus.modelsPath}
                      </code>
                    </p>
                  )}
                </div>
              </div>

              {!cliReady && (
                <div className="rounded-lg border border-border bg-bg-secondary/50 p-3">
                  <p className="text-sm font-medium mb-1">{t("piInstallTitle")}</p>
                  <p className="text-xs text-text-muted mb-2">{t("piInstallInstructions")}</p>
                  <code className="block overflow-x-auto whitespace-pre rounded bg-black/5 dark:bg-white/10 px-3 py-2 text-xs">
                    {t("piInstallCommand")}
                  </code>
                  <a
                    className="mt-2 inline-block text-xs text-primary hover:underline"
                    href="https://github.com/earendil-works/pi"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("openToolDocs")}
                  </a>
                </div>
              )}

              {/* Corrupt / foreign models.json — do not let this read as "empty". */}
              {configError && (
                <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <span className="material-symbols-outlined text-red-500 text-lg">error</span>
                  <div className="flex flex-col gap-1">
                    <p className="text-sm text-red-600 dark:text-red-400">
                      {t("piConfigInvalidTitle")}
                    </p>
                    <p className="text-xs text-text-muted">{configError}</p>
                  </div>
                </div>
              )}

              {cliReady && !configError && (
                <>
                  {/* Current config info */}
                  {configStatus === "configured" && (
                    <div className="flex items-start gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                      <span className="material-symbols-outlined text-green-500 text-lg">
                        check_circle
                      </span>
                      <div className="flex flex-col gap-1">
                        <p className="text-sm text-green-700 dark:text-green-300">
                          {t("piOmnirouteConfigured")}
                        </p>
                        <p className="text-xs text-text-muted">
                          {t("provider")}: <strong>{piStatus.baseUrl || "—"}</strong>
                        </p>
                        <p className="text-xs text-text-muted">
                          {t("model")}: <strong>{piStatus.model || "—"}</strong>
                        </p>
                        {piStatus.omniRouteUnowned && (
                          <p className="text-xs text-yellow-600 dark:text-yellow-400">
                            {t("piUnownedNote")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Model selection */}
                  <div className="flex flex-col gap-2">
                    <label className="text-sm text-text-muted" htmlFor="pi-omniroute-endpoint">
                      {t("piEndpoint")}
                    </label>
                    <input
                      id="pi-omniroute-endpoint"
                      type="url"
                      value={endpointUrl}
                      onChange={(event) => {
                        hasInitializedEndpoint.current = true;
                        setEndpointUrl(event.target.value);
                      }}
                      placeholder={DEFAULT_DISPLAY_BASE_URL}
                      autoComplete="url"
                      className="w-full px-3 py-2 bg-bg-secondary rounded-lg text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                    <p className="text-xs text-text-muted">{t("piEndpointHelp")}</p>
                  </div>

                  {/* Model selection */}
                  <div className="flex flex-col gap-2">
                    <label className="text-sm text-text-muted">{t("model")}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        placeholder={t("providerModelPlaceholder")}
                        className="flex-1 px-3 py-2 bg-bg-secondary rounded-lg text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setModalOpen(true)}
                        disabled={!hasActiveProviders}
                      >
                        {t("select")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowManualConfigModal(true)}
                      >
                        <span className="material-symbols-outlined text-[16px]">edit</span>
                        {t("manualConfig")}
                      </Button>
                    </div>
                    <p className="text-xs text-text-muted">{t("piModelHelp")}</p>
                  </div>

                  {/* API Key selection */}
                  <div className="flex flex-col gap-2">
                    <label className="text-sm text-text-muted">{t("apiKey")}</label>
                    {apiKeys && apiKeys.length > 0 ? (
                      <select
                        value={effectiveApiKeyId}
                        onChange={(e) => setSelectedApiKeyId(e.target.value)}
                        className="px-3 py-2 bg-bg-secondary rounded-lg text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
                      >
                        {apiKeys.map((key) => (
                          <option key={key.id} value={key.id}>
                            {key.key}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-text-muted">
                        {cloudEnabled ? t("noApiKeysAvailable") : t("usingDefaultOmniroute")}
                      </p>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 pt-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleApply}
                      disabled={!selectedModel}
                      loading={applying}
                    >
                      <span className="material-symbols-outlined text-[14px] mr-1">save</span>
                      {configStatus === "configured" ? t("updateConfig") : t("applyConfig")}
                    </Button>
                    {canReset && (
                      <Button variant="outline" size="sm" onClick={handleReset} loading={restoring}>
                        <span className="material-symbols-outlined text-[14px] mr-1">
                          restart_alt
                        </span>
                        {t("reset")}
                      </Button>
                    )}
                  </div>

                  {message && (
                    <div
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {message.type === "success" ? "check_circle" : "error"}
                      </span>
                      <span
                        className={message.containerEphemeralTarget ? "whitespace-pre-line" : ""}
                      >
                        {message.text}
                      </span>
                    </div>
                  )}

                  {/* Copy-paste fallback for remote/headless installs */}
                  <div className="rounded-lg border border-border bg-bg-secondary/50 p-3">
                    <p className="text-xs font-medium text-text-muted mb-2">
                      {t("piManualConfigTitle")}
                    </p>
                    <pre className="text-[11px] font-mono overflow-x-auto whitespace-pre text-text-main">
                      {t("piManualConfigSample")}
                    </pre>
                    <p className="text-xs text-text-muted mt-2">{t("piManualConfigHint")}</p>
                    <p className="text-xs text-text-muted mt-2">{t("piManualMergeHint")}</p>
                  </div>

                  {/* Backups section */}
                  <div className="border-t border-border pt-3 mt-1">
                    <button
                      onClick={() => setShowBackups(!showBackups)}
                      className="flex items-center gap-2 text-sm text-text-muted hover:text-text transition-colors"
                    >
                      <span
                        className={`material-symbols-outlined text-[16px] transition-transform ${showBackups ? "rotate-90" : ""}`}
                      >
                        chevron_right
                      </span>
                      <span className="material-symbols-outlined text-[16px]">backup</span>
                      {t("backups")} {backups.length > 0 && `(${backups.length})`}
                    </button>
                    {showBackups && backups.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1.5 pl-6">
                        {backups.map((b) => (
                          <div
                            key={b.id}
                            className="flex items-center justify-between gap-2 p-2 rounded bg-bg-secondary/50 text-xs"
                          >
                            <div className="flex flex-col">
                              <span className="font-medium">{b.originalFile}</span>
                              <span className="text-text-muted">
                                {new Date(b.createdAt).toLocaleString()}
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRestoreBackup(b.id)}
                              loading={restoringBackup === b.id}
                            >
                              {t("restore")}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {showBackups && backups.length === 0 && (
                      <p className="mt-2 pl-6 text-xs text-text-muted">{t("noBackupsAvailable")}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <ModelSelectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleSelectModel}
        selectedModel={selectedModel}
        activeProviders={activeProviders}
        title={t("selectModelForTool", { tool: "Pi" })}
      />
      {showManualConfigModal && (
        <ManualConfigModal
          isOpen={showManualConfigModal}
          onClose={() => setShowManualConfigModal(false)}
          title={t("piManualConfiguration")}
          configs={getManualConfigs()}
        />
      )}
    </Card>
  );
}
