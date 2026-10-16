<script lang="ts">
	import { onMount } from 'svelte';

	import { type ProviderConfig } from '#lib/model';
	import { type SettingsService } from '#lib/service';
	import { appState } from '#lib/state';

	const SAVE_DEBOUNCE_MS = 500;
	let settingsService: SettingsService | undefined;
	let isSettingsAvailable = $state(false);

	type ProviderConfigField = keyof ProviderConfig;

	const providerConfigFields: {
		key: ProviderConfigField;
		label: string;
		placeholder: string;
	}[] = [
		{ key: 'endpoint', label: 'Endpoint', placeholder: 'https://api.deepseek.com' },
		{ key: 'model', label: 'Model (optional)', placeholder: 'deepseek-flash' },
		{ key: 'apiKey', label: 'API key (optional)', placeholder: 'sk-****' }
	];

	let providerConfig: ProviderConfig = $state({
		endpoint: '',
		model: '',
		apiKey: ''
	});
	let isLoading = $state(true);
	let settingsError = $state('');

	let saveTimeout: ReturnType<typeof setTimeout> | undefined;
	let latestSaveVersion = 0;
	let isUnmounted = false;

	async function loadProviderConfig(): Promise<void> {
		try {
			settingsService = await appState.getSettingsService();
			if (isUnmounted) return;

			isSettingsAvailable = true;
			const savedConfig = await settingsService.getProviderConfig();
			if (isUnmounted) return;

			if (savedConfig !== undefined) {
				providerConfig = savedConfig;
			}
		} catch (error: unknown) {
			if (!isUnmounted) {
				settingsError = errorMessage(error);
			}
		} finally {
			if (!isUnmounted) {
				isLoading = false;
			}
		}
	}

	function updateProviderConfig(field: ProviderConfigField, value: string): void {
		providerConfig = { ...providerConfig, [field]: value };
		settingsError = '';
		latestSaveVersion += 1;
		clearSaveTimeout();

		const version = latestSaveVersion;
		const config = { ...providerConfig };
		saveTimeout = setTimeout(() => {
			saveTimeout = undefined;
			persistProviderConfig(config, version);
		}, SAVE_DEBOUNCE_MS);
	}

	function clearSaveTimeout(): void {
		if (saveTimeout !== undefined) {
			clearTimeout(saveTimeout);
			saveTimeout = undefined;
		}
	}

	function flushPendingSave(): void {
		if (saveTimeout === undefined) return;

		clearSaveTimeout();
		persistProviderConfig({ ...providerConfig }, latestSaveVersion);
	}

	function isProviderConfigEmpty(config: ProviderConfig): boolean {
		return Object.values(config).every((value) => value.trim() === '');
	}

	function persistProviderConfig(config: ProviderConfig, version: number): void {
		if (settingsService === undefined) return;

		const persistence = isProviderConfigEmpty(config)
			? settingsService.deleteProviderConfig()
			: settingsService.saveProviderConfig(config);

		void persistence.catch((error: unknown) => {
			if (!isUnmounted && version === latestSaveVersion) {
				settingsError = errorMessage(error);
			}
		});
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : 'An unexpected settings error occurred.';
	}

	onMount(() => {
		void loadProviderConfig();

		return () => {
			isUnmounted = true;
			flushPendingSave();
		};
	});
</script>

<form class="flex flex-col gap-2" onsubmit={(event) => event.preventDefault()}>
	<div>
		{#each providerConfigFields as field (field.key)}
			<label class="fieldset">
				<span class="fieldset-legend">{field.label}</span>
				<input
					class="input w-full"
					name={field.key}
					placeholder={field.placeholder}
					value={providerConfig[field.key]}
					disabled={isLoading || !isSettingsAvailable}
					oninput={(event) => updateProviderConfig(field.key, event.currentTarget.value)}
					onkeydown={(event) => {
						if (event.key !== 'Enter') return;
						event.preventDefault();
						flushPendingSave();
						event.currentTarget.blur();
					}}
				/>
			</label>
		{/each}
	</div>

	<div class="h-10">
		{#if settingsError}
			<p role="alert">{settingsError}</p>
		{/if}
	</div>
</form>
