import WebSocket from "ws"
import http from "http"
import { SELECTORS } from "./selectors.js"

const PORTS = [9222, 9000, 9001, 9002, 9003]
const CDP_CALL_TIMEOUT = 30000

export class CDPService {
	constructor(logger = console.log) {
		this.cdpConnection = null
		this.logger = logger
	}

	// --- CDP HELPERS ---
	getJson(url) {
		return new Promise((resolve, reject) => {
			http
				.get(url, (res) => {
					let data = ""
					res.on("data", (chunk) => (data += chunk))
					res.on("end", () => {
						try {
							resolve(JSON.parse(data))
						} catch (e) {
							reject(e)
						}
					})
				})
				.on("error", reject)
		})
	}

	async discoverCDP() {
		for (const port of PORTS) {
			try {
				const list = await this.getJson(`http://127.0.0.1:${port}/json/list`)
				this.logger(`[CDP] Checking port ${port}, found ${list.length} targets.`, "info")

				let target = list.find(
					(t) =>
						t.type === "page" &&
						t.webSocketDebuggerUrl &&
						!t.title.includes("Launchpad") &&
						!t.url.includes("workbench-jetski-agent") &&
						(t.url.includes("workbench") ||
							t.title.includes("Antigravity") ||
							t.title.includes("Cascade")),
				)

				if (!target) {
					target = list.find(
						(t) =>
							t.webSocketDebuggerUrl &&
							(t.url.includes("workbench") ||
								t.title.includes("Antigravity") ||
								t.title.includes("Cascade")) &&
							!t.title.includes("Launchpad"),
					)
				}

				if (!target) {
					target = list.find(
						(t) =>
							t.webSocketDebuggerUrl &&
							(t.url.includes("workbench") ||
								t.title.includes("Antigravity") ||
								t.title.includes("Cascade") ||
								t.title.includes("Launchpad")),
					)
				}

				if (target && target.webSocketDebuggerUrl) {
					this.logger(
						`[CDP] Connected to target: ${target.title} (${target.url})`,
						"info",
					)
					return { port, url: target.webSocketDebuggerUrl }
				}
			} catch (e) {
				// Ignore port check failures
			}
		}
		throw new Error("CDP not found.")
	}

	async connectCDP(url) {
		const ws = new WebSocket(url)
		await new Promise((resolve, reject) => {
			ws.on("open", resolve)
			ws.on("error", reject)
		})
		const contexts = []
		let idCounter = 1
		const pending = new Map()

		ws.on("message", (msg) => {
			try {
				const data = JSON.parse(msg)
				if (data.id !== undefined && pending.has(data.id)) {
					const { resolve, reject, timeoutId } = pending.get(data.id)
					clearTimeout(timeoutId)
					pending.delete(data.id)
					if (data.error) reject(data.error)
					else resolve(data.result)
				}
				if (data.method === "Runtime.executionContextCreated")
					contexts.push(data.params.context)
				if (data.method === "Runtime.executionContextDestroyed") {
					const idx = contexts.findIndex((c) => c.id === data.params.executionContextId)
					if (idx !== -1) contexts.splice(idx, 1)
				}
			} catch (e) {}
		})

		const call = (method, params) =>
			new Promise((resolve, reject) => {
				const id = idCounter++
				const timeoutId = setTimeout(() => {
					if (pending.has(id)) {
						pending.delete(id)
						reject(new Error("Timeout"))
					}
				}, CDP_CALL_TIMEOUT)
				pending.set(id, { resolve, reject, timeoutId })
				ws.send(JSON.stringify({ id, method, params }))
			})

		ws.on("close", () => {
			this.logger("WebSocket disconnected.", "disconnect")
			if (this.cdpConnection && this.cdpConnection.ws === ws) {
				this.cdpConnection = null
			}
		})

		await call("Runtime.enable", {})
		await call("Runtime.disable", {})
		await call("Runtime.enable", {})
		await new Promise((r) => setTimeout(r, 1000))

		return { ws, call, contexts }
	}

	async ensureCDP() {
		if (this.cdpConnection && this.cdpConnection.ws.readyState === WebSocket.OPEN)
			return this.cdpConnection
		try {
			const { url } = await this.discoverCDP()
			this.cdpConnection = await this.connectCDP(url)
			return this.cdpConnection
		} catch (e) {
			return null
		}
	}

	// --- DOM SCRIPTS ---
	async injectMessage(text, attachments = []) {
		const cdp = await this.ensureCDP()
		if (!cdp) return { ok: false, error: "CDP not connected" }

		const safeText = JSON.stringify(text)
		const safeAttachments = JSON.stringify(attachments)

		const EXP = `(async () => {
            const SELECTORS = ${JSON.stringify(SELECTORS)};
            function isSubmitButton(btn) {
                if (btn.disabled || btn.offsetWidth === 0) return false;
                const svg = btn.querySelector('svg');
                if (svg) {
                    const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                    if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
                }
                const txt = (btn.innerText || '').trim().toLowerCase();
                if (['send', 'run'].includes(txt)) return true;
                return false;
            }
            const doc = document;
            const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT));
            const validEditors = editors.filter(el => el.offsetParent !== null);
            const editor = validEditors.at(-1);
            if (!editor) return { ok: false, error: "No editor found in this context" };
            editor.focus();

            const attData = ${safeAttachments};
            if (attData && attData.length > 0) {
                const dt = new DataTransfer();
                for (const att of attData) {
                    const res = await fetch('data:' + att.mimeType + ';base64,' + att.data);
                    const blob = await res.blob();
                    const file = new File([blob], att.name, { type: att.mimeType });
                    dt.items.add(file);
                }
                const dropEvent = new DragEvent("drop", {
                   bubbles: true,
                   cancelable: true,
                   dataTransfer: dt
                });
                editor.dispatchEvent(dropEvent);
                const pasteEvent = new ClipboardEvent("paste", {
                   bubbles: true,
                   cancelable: true,
                   clipboardData: dt
                });
                editor.dispatchEvent(pasteEvent);
                await new Promise(r => setTimeout(r, 500)); // wait for file processing
            }

            let inserted = doc.execCommand("insertText", false, ${safeText});
            if (!inserted) {
                editor.textContent = ${safeText};
                editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: ${safeText} }));
                editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: ${safeText} }));
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            const allButtons = Array.from(doc.querySelectorAll(SELECTORS.SUBMIT_BUTTON_CONTAINER));
            const submit = allButtons.find(isSubmitButton);
            if (submit) {
                 submit.click();
                 return { ok: true, method: "click" };
            }
            editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
            return { ok: true, method: "enter" };
        })()`

		const targetContexts = cdp.contexts.filter(
			(c) =>
				(c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
				(c.name && c.name.includes("Extension")),
		)
		const contextsToTry = targetContexts.length > 0 ? targetContexts : cdp.contexts

		for (const ctx of contextsToTry) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					awaitPromise: true,
					contextId: ctx.id,
				})
				if (res.result?.value?.ok) {
					this.logger(`Sent: ${text} (Context: ${ctx.id})`, "inject")
					return res.result.value
				}
			} catch (e) {}
		}

		if (targetContexts.length > 0) {
			const otherContexts = cdp.contexts.filter((c) => !targetContexts.includes(c))
			for (const ctx of otherContexts) {
				try {
					const res = await cdp.call("Runtime.evaluate", {
						expression: EXP,
						returnByValue: true,
						awaitPromise: true,
						contextId: ctx.id,
					})
					if (res.result?.value?.ok) {
						this.logger(`Sent: ${text} (Fallback Context: ${ctx.id})`, "inject")
						return res.result.value
					}
				} catch (e) {}
			}
		}
		return {
			ok: false,
			error: `Injection failed. Tried ${cdp.contexts.length} contexts.`,
		}
	}

	async checkIsGenerating() {
		const cdp = await this.ensureCDP()
		if (!cdp) return false

		const EXP = `(() => {
            function findAgentFrame(win) {
                 const iframes = document.querySelectorAll('iframe');
                 for(let i=0; i<iframes.length; i++) {
                     if(iframes[i].src.includes('cascade-panel')) {
                         try { return iframes[i].contentDocument; } catch(e){}
                     }
                 }
                 return document;
            }
            const doc = findAgentFrame(window);
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel && cancel.offsetParent !== null) return true;
            return false;
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value === true) return true
			} catch (e) {}
		}
		return false
	}

	async checkApprovalRequired() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		const EXP = `(() => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for(let i=0; i<iframes.length; i++) {
                    if(iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch(e){}
                    }
                }
                return document; 
            }
            const doc = getTargetDoc();
            if (!doc) return null;

            const approvalKeywords = [
                'run', 'approve', 'allow', 'yes', 'accept', 'confirm', 
                'save', 'apply', 'create', 'update', 'delete', 'remove', 'submit', 'send', 'retry', 'continue',
                'always allow', 'allow once', 'allow this conversation',
                '実行', '許可', '承認', 'はい', '同意', '保存', '適用', '作成', '更新', '削除', '送信', '再試行', '続行'
            ];
            const anchorKeywords = ['cancel', 'reject', 'deny', 'ignore', 'キャンセル', '拒否', '無視', 'いいえ', '不許可'];
            const ignoreKeywords = ['all', 'すべて', '一括', 'auto'];

            let found = null;

            function scan(root) {
                if (found) return;
                if (!root) return;
                
                const potentialAnchors = Array.from(root.querySelectorAll ? root.querySelectorAll('button, [role="button"], .cursor-pointer') : []).filter(el => {
                    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
                    const txt = (el.innerText || '').trim().toLowerCase();
                    return anchorKeywords.some(kw => txt === kw || txt.startsWith(kw + ' '));
                });

                for (const anchor of potentialAnchors) {
                    if (found) return;

                    const container = anchor.closest('.flex') || anchor.parentElement;
                    if (!container) continue;

                    const parent = container.parentElement;
                    if (!parent) continue;

                    const searchScope = parent.parentElement || parent;
                    const buttons = Array.from(searchScope.querySelectorAll('button, [role="button"], .cursor-pointer'));
                    
                    const approvalButton = buttons.find(btn => {
                        if (btn === anchor) return false;
                        if (btn.offsetWidth === 0) return false;
                        
                        const txt = (btn.innerText || '').toLowerCase().trim();
                        const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                        const title = (btn.getAttribute('title') || '').toLowerCase().trim();
                        const combined = txt + ' ' + aria + ' ' + title;
                        
                        return approvalKeywords.some(kw => combined.includes(kw)) && 
                               !ignoreKeywords.some(kw => combined.includes(kw));
                    });

                    if (approvalButton) {
                        let textContext = "Command or Action requiring approval";
                        const itemContainer = searchScope.closest('.flex.flex-col.gap-2.border-gray-500/25') || 
                                              searchScope.closest('.group') || 
                                              searchScope.closest('.prose')?.parentElement;
                        
                        if (itemContainer) {
                             const prose = itemContainer.querySelector('.prose');
                             const pre = itemContainer.querySelector('pre');
                             const header = itemContainer.querySelector('.text-sm.border-b') || itemContainer.querySelector('.font-semibold');
                             
                             let msg = [];
                             if (header) msg.push('[Header] ' + header.innerText.trim());
                             if (prose) msg.push(prose.innerText.trim());
                             if (pre) msg.push('[Command] ' + pre.innerText.trim());
                             
                             if (msg.length > 0) textContext = msg.join('\\n\\n');
                             else textContext = itemContainer.innerText.trim();
                        }

                        found = { required: true, message: textContext.substring(0, 1500) };
                        return;
                    }
                }

                try {
                    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
                    let n;
                    while (n = walker.nextNode()) {
                        if (found) return;
                        if (n.shadowRoot) scan(n.shadowRoot);
                    }
                } catch(e){}
            }

            scan(doc.body);
            return found;
        })()`

		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value?.required) return res.result.value
			} catch (e) {}
		}
		return null
	}

	async clickApproval(allow) {
		const cdp = await this.ensureCDP()
		if (!cdp) return { success: false }

		const isAllowStr = allow ? "true" : "false"
		const EXP =
			"(async () => {" +
			"function getTargetDoc() {" +
			'  var iframes = document.querySelectorAll("iframe");' +
			"  for (var i = 0; i < iframes.length; i++) {" +
			'    if (iframes[i].src.indexOf("cascade-panel") !== -1) {' +
			"      try { return iframes[i].contentDocument; } catch(e) {}" +
			"    }" +
			"  }" +
			"  return document;" +
			"}" +
			"var doc = getTargetDoc();" +
			"var log = []; " +
			'var approvalKeywords = ["run","approve","allow","yes","accept","confirm","save","apply","create","update","delete","remove","submit","send","retry","continue","always allow","allow once","allow this conversation","実行","許可","承認","はい","同意","保存","適用","作成","更新","削除","送信","再試行","続行"];' +
			'var cancelKeywords = ["cancel","reject","deny","ignore","no","キャンセル","拒否","無視","いいえ","中止","不許可"];' +
			'var ignoreKeywords = ["all","すべて","一括","auto"];' +
			"var isAllow = " +
			isAllowStr +
			";" +
			"var found = false;" +
			"function matchKeyword(combined, kw) {" +
			"  if (kw.length <= 4) {" +
			'    return combined === kw || combined.indexOf(kw) === 0 || combined.indexOf(" " + kw) !== -1;' +
			"  }" +
			"  return combined.indexOf(kw) !== -1;" +
			"}" +
			'var allButtons = Array.from(doc.body ? doc.body.querySelectorAll("button, [role="button"], .cursor-pointer") : []);' +
			'log.push("Total buttons found: " + allButtons.length);' +
			"var anchors = allButtons.filter(function(el) {" +
			"  if (el.offsetWidth === 0) return false;" +
			'  var txt = (el.innerText || "").trim().toLowerCase();' +
			'  return cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; });' +
			"});" +
			'log.push("Cancel anchors found: " + anchors.length);' +
			"if (!isAllow && anchors.length > 0) {" +
			"  anchors[0].click();" +
			"  found = true;" +
			"}" +
			"if (isAllow && !found) {" +
			"  allButtons.forEach(function(btn) {" +
			"    if (btn.offsetWidth === 0) return;" +
			'    var txt = (btn.innerText || "").trim().substring(0, 60);' +
			'    log.push("Btn: " + JSON.stringify(txt));' +
			"  });" +
			"  var approvalBtns = allButtons.filter(function(btn) {" +
			"    if (btn.offsetWidth === 0) return false;" +
			'    var txt = (btn.innerText || "").toLowerCase().trim();' +
			"    if (txt.length > 30) return false;" +
			'    if (cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; })) return false;' +
			'    var aria = (btn.getAttribute("aria-label") || "").toLowerCase().trim();' +
			'    var title = (btn.getAttribute("title") || "").toLowerCase().trim();' +
			'    var combined = txt + " " + aria + " " + title;' +
			"    return approvalKeywords.some(function(kw) { return matchKeyword(combined, kw); }) && " +
			"           !ignoreKeywords.some(function(kw) { return combined.indexOf(kw) !== -1; });" +
			"  });" +
			"  approvalBtns.sort(function(a, b) {" +
			'     var txtA = (a.innerText || "").toLowerCase();' +
			'     var txtB = (b.innerText || "").toLowerCase();' +
			'     var scoreA = 0; if(txtA.indexOf("allow this conversation") !== -1) scoreA = 2; else if(txtA.indexOf("always allow") !== -1) scoreA = 1;' +
			'     var scoreB = 0; if(txtB.indexOf("allow this conversation") !== -1) scoreB = 2; else if(txtB.indexOf("always allow") !== -1) scoreB = 1;' +
			"     return scoreB - scoreA;" +
			"  });" +
			"  var approvalBtn = approvalBtns[0];" +
			"  if (approvalBtn) {" +
			'    log.push("CLICKING: " + (approvalBtn.innerText || "").trim().substring(0, 30));' +
			"    approvalBtn.click();" +
			"    found = true;" +
			"  } else {" +
			'    log.push("No approval button found!");' +
			"  }" +
			"}" +
			"return { success: found, log: log };" +
			"})()"
		for (const ctx of cdp.contexts) {
			try {
				const evalPromise = cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					awaitPromise: true,
					contextId: ctx.id,
				})
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 5000),
				)
				const res = await Promise.race([evalPromise, timeoutPromise])
				if (res.result?.value?.success) {
					this.logger(`Approval / Rejection clicked: ${allow} (success)`, "click")
					return res.result.value
				}
			} catch (e) {}
		}
		this.logger(`Approval / Rejection clicked: ${allow} (failed)`, "click")
		return { success: false }
	}

	async getLastResponse() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		const EXP = `(() => {
                function getTargetDoc() {
                    const iframes = document.querySelectorAll('iframe');
                    for (let i = 0; i < iframes.length; i++) {
                        if (iframes[i].src.includes('cascade-panel')) {
                            try { return iframes[i].contentDocument; } catch(e) {}
                        }
                    }
                    return document;
                }
                const doc = getTargetDoc();
                const candidates = Array.from(doc.querySelectorAll('[data-message-role="assistant"], .prose, .group.relative.flex.gap-3, .leading-relaxed, .animate-markdown, .custom-html-style'));
                if (candidates.length === 0) {
                    const fallback = Array.from(doc.querySelectorAll('div > p, div > span')).filter(el => el.innerText && el.innerText.length > 10);
                    if (fallback.length === 0) return null;
                    return { text: fallback[fallback.length - 1].innerText, images: [] };
                }
                const lastMsg = candidates[candidates.length - 1];
                return { text: lastMsg.innerText, images: Array.from(lastMsg.querySelectorAll('img')).map(img => img.src) };
            })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value?.text) return res.result.value
			} catch (e) {}
		}
		return null
	}

	async waitForCompletion(timeoutMs = 600000) {
		const cdp = await this.ensureCDP()
		if (!cdp) return { status: "error", message: "CDP not connected" }

		const startTime = Date.now()
		let stableCount = 0

		// 最初はUIスレッドが生成を開始するまで若干待機する
		await new Promise((r) => setTimeout(r, 2000))

		while (Date.now() - startTime < timeoutMs) {
			try {
				const approval = await this.checkApprovalRequired()
				if (approval && approval.required) {
					return { status: "approval_required", message: approval.message }
				}

				const generating = await this.checkIsGenerating()
				if (!generating) {
					stableCount++
					// 3回連続(約1.5秒)非生成状態なら完了とみなす
					if (stableCount >= 3) {
						const response = await this.getLastResponse()
						return { status: "completed", response: response ? response.text : null }
					}
				} else {
					stableCount = 0
				}
			} catch (e) {
				// ループ中の例外は無視して続行
			}

			await new Promise((r) => setTimeout(r, 500))
		}

		return { status: "timeout", message: "Timeout waiting for completion" }
	}

	async getScreenshot() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		try {
			const result = await cdp.call("Page.captureScreenshot", { format: "png" })
			return Buffer.from(result.data, "base64")
		} catch (e) {
			return null
		}
	}

	async stopGeneration() {
		const cdp = await this.ensureCDP()
		if (!cdp) return false

		const EXP = `(() => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if (iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch(e) {}
                    }
                }
                return document;
            }
            const doc = getTargetDoc();
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel && cancel.offsetParent !== null) {
                cancel.click();
                return { success: true };
            }
            const buttons = doc.querySelectorAll('button');
            for (const btn of buttons) {
                const txt = (btn.innerText || '').trim().toLowerCase();
                if (txt === 'stop' || txt === '停止') {
                    btn.click();
                    return { success: true };
                }
            }
            return { success: false, reason: 'Cancel button not found' };
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value?.success) {
					this.logger("Generation stopped by user.", "stop")
					return true
				}
			} catch (e) {}
		}
		return false
	}

	async startNewChat() {
		const cdp = await this.ensureCDP()
		if (!cdp) return false

		const EXP = `(() => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if (iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch(e) {}
                    }
                }
                return null;
            }
            const selectors = [
                '[data-tooltip-id="new-conversation-tooltip"]',
                '[data-tooltip-id*="new-chat"]',
                '[data-tooltip-id*="new_chat"]',
                '[aria-label*="New Chat"]',
                '[aria-label*="New Conversation"]'
            ];
            const docs = [document];
            const iframeDoc = getTargetDoc();
            if (iframeDoc) docs.push(iframeDoc);
            for (const doc of docs) {
                for (const sel of selectors) {
                    const btn = doc.querySelector(sel);
                    if (btn) { btn.click(); return { success: true, method: sel }; }
                }
            }
            return { success: false };
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value?.success) {
					this.logger("New chat started.", "newchat")
					return true
				}
			} catch (e) {}
		}
		return false
	}

	async getCurrentModel() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		const EXP = `(() => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
            }
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            return txt;
                        }
                    }
                    if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        if (btn.querySelector('svg')) {
                            return txt;
                        }
                    }
                }
            }
            return null;
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value) return res.result.value
			} catch (e) {}
		}
		return null
	}

	async getCurrentTitle() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		const EXP = `(() => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
            }
            
            // Primary strategy: Grab the actual window title which contains the context (e.g. "openclaw-gravity - Antigravity - mcporter.json")
            if (document.title && document.title.length > 2) {
                return document.title;
            }

            // Fallback strategy: Old sidebar title
            for (const doc of docs) {
                const els = doc.querySelectorAll('p.text-ide-sidebar-title-color');
                for (const el of els) {
                    const txt = (el.innerText || '').trim();
                    if (txt.length > 1) return txt;
                }
            }
            return null;
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value) return res.result.value
			} catch (e) {}
		}
		return null
	}

	async getModelList() {
		const cdp = await this.ensureCDP()
		if (!cdp) return []

		const EXP = `(async () => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
            }
            let targetDoc = null;
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                    if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        if (btn.querySelector('svg')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                }
                if (targetDoc) break;
            }
            if (!targetDoc) return JSON.stringify([]);
            await new Promise(r => setTimeout(r, 1000));
            
            let models = [];
            const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
            for (const opt of options) {
                if (opt.className.includes('px-') || opt.className.includes('py-')) {
                     const txt = (opt.textContent || '').replace('New', '').trim();
                     if(txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                         if(!models.includes(txt)) models.push(txt);
                     }
                }
            }
            
            const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
            if (openBtn) openBtn.click();
            
            return JSON.stringify(models);
        })()`

		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					awaitPromise: true,
					contextId: ctx.id,
				})
				if (res.result?.value) {
					const models = JSON.parse(res.result.value)
					if (models.length > 0) return models
				}
			} catch (e) {}
		}
		return []
	}

	async switchModel(targetName) {
		const cdp = await this.ensureCDP()
		if (!cdp) return { success: false, reason: "CDP not connected" }

		const SWITCH_EXP = `(async () => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
            }
            let targetDoc = null;
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                    if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        if (btn.querySelector('svg')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                }
                if (targetDoc) break;
            }
            if (!targetDoc) return JSON.stringify({ success: false, reason: 'button not found' });
            await new Promise(r => setTimeout(r, 1000));
            
            const target = ${JSON.stringify(targetName)}.toLowerCase();
            const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
            for (const opt of options) {
                if (opt.className.includes('px-') || opt.className.includes('py-')) {
                     const txt = (opt.textContent || '').replace('New', '').trim();
                     if (txt.toLowerCase().includes(target)) {
                         opt.click();
                         return JSON.stringify({ success: true, model: txt });
                     }
                }
            }
            
            const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
            if (openBtn) openBtn.click();
            return JSON.stringify({ success: false, reason: 'model not found in options list' });
        })()`

		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: SWITCH_EXP,
					returnByValue: true,
					awaitPromise: true,
					contextId: ctx.id,
				})
				if (res.result?.value) {
					const result = JSON.parse(res.result.value)
					if (result.success) {
						this.logger(`Switched to: ${result.model}`, "model")
						return result
					}
				}
			} catch (e) {}
		}
		return { success: false, reason: "CDP error" }
	}

	async getCurrentMode() {
		const cdp = await this.ensureCDP()
		if (!cdp) return null

		const EXP = `(() => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if (iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch (e) { }
                    }
                }
                return document;
            }
            const doc = getTargetDoc();
            const spans = doc.querySelectorAll('span.text-xs.select-none');
            for (const s of spans) {
                const txt = (s.innerText || '').trim();
                if (txt === 'Planning' || txt === 'Fast') return txt;
            }
            return null;
        })()`
		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: EXP,
					returnByValue: true,
					contextId: ctx.id,
				})
				if (res.result?.value) return res.result.value
			} catch (e) {}
		}
		return null
	}

	async switchMode(targetMode) {
		const cdp = await this.ensureCDP()
		if (!cdp) return { success: false, reason: "CDP not connected" }

		const SWITCH_EXP = `(async () => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if (iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch (e) { }
                    }
                }
                return document;
            }
            const doc = getTargetDoc();
            const toggles = doc.querySelectorAll('div[role="button"][aria-haspopup="dialog"]');
            let clicked = false;
            for (const t of toggles) {
                const txt = (t.innerText || '').trim();
                if (txt === 'Planning' || txt === 'Fast') {
                    t.querySelector('button').click();
                    clicked = true;
                    break;
                }
            }
            if (!clicked) return JSON.stringify({ success: false, reason: 'toggle not found' });
            await new Promise(r => setTimeout(r, 1000));
            
            const target = ${JSON.stringify(targetMode)};
            const dialogs = doc.querySelectorAll('div[role="dialog"]');
            for (const dialog of dialogs) {
                const txt = (dialog.innerText || '');
                if (txt.includes('Conversation mode') || txt.includes('Planning') && txt.includes('Fast')) {
                    const divs = dialog.querySelectorAll('div.font-medium');
                    for (const d of divs) {
                        if (d.innerText.trim().toLowerCase() === target.toLowerCase()) {
                            d.click();
                            return JSON.stringify({ success: true, mode: d.innerText.trim() });
                        }
                    }
                }
            }
            return JSON.stringify({ success: false, reason: 'mode not found in dialog' });
        })()`

		for (const ctx of cdp.contexts) {
			try {
				const res = await cdp.call("Runtime.evaluate", {
					expression: SWITCH_EXP,
					returnByValue: true,
					awaitPromise: true,
					contextId: ctx.id,
				})
				if (res.result?.value) {
					const result = JSON.parse(res.result.value)
					if (result.success) {
						this.logger(`Switched to: ${result.mode} `, "mode")
						return result
					}
				}
			} catch (e) {}
		}
		return { success: false, reason: "CDP error" }
	}
}
