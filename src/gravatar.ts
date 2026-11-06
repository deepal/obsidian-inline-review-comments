const RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface LocalSettings {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

interface Avatar {
	element: HTMLElement;
	author: string;
	image?: HTMLImageElement;
}

function normalizeEmail(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function loadPhoto(email: string, controller: AbortController): Promise<string | null> {
	const { signal } = controller;
	const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let photo: string | null = null;
	try {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
		if (signal.aborted) return null;
		const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const response = await fetch(`https://gravatar.com/avatar/${hash}?s=64&d=404`, {
			signal,
			credentials: "omit",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok) return null;
		photo = URL.createObjectURL(await response.blob());
		const image = new Image();
		image.src = photo;
		await image.decode();
		if (signal.aborted) return null;
		const decoded = photo;
		photo = null; // The caller owns the decoded image URL.
		return decoded;
	} catch {
		return null;
	} finally {
		window.clearTimeout(timeout);
		if (photo) URL.revokeObjectURL(photo);
	}
}

/** One optional photo per plugin and vault. Renderers own their avatar bindings. */
export class Gravatar {
	private email: string;
	private readonly avatars = new Set<Avatar>();
	private request: AbortController | null = null;
	private photo: string | null = null;
	private retryAt = 0;
	private readonly storage: LocalSettings;
	private readonly key: string;
	private readonly getAuthor: () => string | null;

	constructor(storage: LocalSettings, key: string, getAuthor: () => string | null) {
		this.storage = storage;
		this.key = key;
		this.getAuthor = getAuthor;
		this.email = normalizeEmail(storage.loadLocalStorage(key));
	}

	getEmail(): string {
		return this.email;
	}

	setEmail(value: string): void {
		const email = normalizeEmail(value);
		if (email === this.email) return;
		this.storage.saveLocalStorage(this.key, email || null);
		this.email = email;
		this.resetPhoto();
		this.refresh();
	}

	bind(element: HTMLElement, author: string | null): () => void {
		if (!author) return () => {};
		const avatar: Avatar = { element, author };
		this.avatars.add(avatar);
		this.update(avatar);
		return () => {
			this.avatars.delete(avatar);
			this.show(avatar, null);
		};
	}

	refresh(): void {
		for (const avatar of this.avatars) this.update(avatar);
	}

	destroy(): void {
		for (const avatar of this.avatars) this.show(avatar, null);
		this.avatars.clear();
		this.resetPhoto();
	}

	private resetPhoto(): void {
		this.request?.abort();
		this.request = null;
		if (this.photo) URL.revokeObjectURL(this.photo);
		this.photo = null;
		this.retryAt = 0;
	}

	private update(avatar: Avatar): void {
		const matches = !!this.email && avatar.author === this.getAuthor();
		this.show(avatar, matches ? this.photo : null);
		if (matches && !this.photo && !this.request && Date.now() >= this.retryAt) {
			const request = new AbortController();
			this.request = request;
			void loadPhoto(this.email, request).then((photo) => {
				if (this.request !== request) {
					if (photo) URL.revokeObjectURL(photo);
					return;
				}
				this.request = null;
				this.photo = photo;
				this.retryAt = Date.now() + RETRY_DELAY_MS;
				this.refresh();
			});
		}
	}

	private show(avatar: Avatar, photo: string | null): void {
		if (avatar.image ? avatar.image.src === photo : !photo) return;
		avatar.image?.remove();
		avatar.image = undefined;
		avatar.element.classList.remove("has-gravatar");
		if (!photo) return;

		const image = avatar.element.createEl("img", {
			cls: "gravatar-avatar-image",
			attr: { alt: "" },
		});
		image.addEventListener("load", () => {
			if (avatar.image === image) avatar.element.classList.add("has-gravatar");
		}, { once: true });
		avatar.image = image;
		image.src = photo;
	}
}
