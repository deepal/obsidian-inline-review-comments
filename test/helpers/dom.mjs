// Minimal DOM host for exercising real card/composer event and lifecycle code in Node.
export function documentFixture() {
	globalThis.HTMLTableElement = class HTMLTableElement {};
	globalThis.ResizeObserver = class {
		static instances = [];
		constructor(callback) { this.callback = callback; this.observed = new Set(); this.constructor.instances.push(this); }
		observe(el) { this.observed.add(el); } unobserve(el) { this.observed.delete(el); } disconnect() { this.observed.clear(); }
	};
	const doc = Object.assign(new EventTarget(), { activeElement: null });
	const frames = new Map(); let nextFrame = 0;
	doc.flushFrames = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
	doc.pendingFrames = () => frames.size;
	class Element extends EventTarget {
		constructor(tag = "div", options = {}) {
			super();
			this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentElement = null; this.children = [];
			this.dataset = {}; this.attributes = {}; this.style = {
				setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name] ?? ""; },
				getPropertyPriority() { return ""; }, removeProperty(name) { delete this[name]; },
			}; this.classes = new Set((options.cls ?? "").split(/\s+/).filter(Boolean));
			this.classList = { contains: (name) => this.classes.has(name), add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
			this.win = { getComputedStyle: () => ({ position: "relative" }),
				requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
				cancelAnimationFrame(id) { frames.delete(id); },
			};
			this.value = ""; this.disabled = false; this.selectionStart = this.selectionEnd = 0; this.selectionDirection = "none"; this.offsetHeight = 80;
			this.clientWidth = 200; this.clientHeight = 78; this.scrollHeight = 78;
			for (const [key, value] of Object.entries(options.attr ?? {})) this.setAttribute(key, value);
		}
		get isConnected() { return this === doc.body || !!this.parentElement?.isConnected; }
		getBoundingClientRect() { return { top: this.top ?? 0, height: this.offsetHeight, width: this.clientWidth }; }
		createEl(tag, options) { return this.appendChild(new Element(tag, options)); }
		createDiv(options) { return this.createEl("div", options); }
		createSpan(options) { return this.createEl("span", options); }
		appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
		contains(other) { return other === this || this.children.some((child) => child.contains(other)); }
		addClass(name) { this.classList.add(name); }
		setText(text) { this.textContent = text; }
		setCssProps(properties) { Object.assign(this.style, properties); }
		empty() { for (const child of [...this.children]) child.remove(); }
		click() { this.dispatchEvent(new Event("click", { cancelable: true })); }
		setAttribute(key, value) { this.attributes[key] = value; }
		getAttribute(key) { return this.attributes[key]; }
		setSelectionRange(start, end, direction = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
		matches(selector) {
			if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
			const attribute = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
			if (attribute) { const key = attribute[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return key in this.dataset && (attribute[2] === undefined || this.dataset[key] === attribute[2]); }
			return this.tagName.toLowerCase() === selector;
		}
		instanceOf(type) { return type === globalThis.HTMLTableElement ? this.tagName === "TABLE" : this instanceof type; }
		closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
		querySelectorAll(selector) {
			const parts = selector.split(" ");
			const match = (el) => {
				if (!el.matches(parts.at(-1))) return false;
				let parent = el.parentElement;
				for (const part of parts.slice(0, -1).reverse()) {
					while (parent && !parent.matches(part)) parent = parent.parentElement;
					if (!parent) return false;
					parent = parent.parentElement;
				}
				return true;
			};
			return this.children.flatMap((child) => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
		}
		querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
		focus() {
			if (doc.activeElement === this) return;
			doc.activeElement?.dispatchEvent(new Event("blur"));
			doc.activeElement = this; this.dispatchEvent(new Event("focus"));
			const event = new Event("focusin"); Object.defineProperty(event, "target", { value: this }); doc.dispatchEvent(event);
		}
		remove() {
			if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
			if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
			this.parentElement = null;
		}
	}
	doc.body = new Element("body"); doc.activeElement = doc.body;
	globalThis.createDiv = (options) => new Element("div", options);
	return doc;
}

export function key(input, options) {
	const event = new Event("keydown", { cancelable: true });
	Object.assign(event, { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false }, options);
	input.dispatchEvent(event);
	return event;
}
