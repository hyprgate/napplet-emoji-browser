import '@napplet/shim';
import '@unocss/reset/tailwind.css';

import { installBuiltInThemeClient } from '@hyprgate/utils';
import { mount } from 'svelte';
import App from './App.svelte';

installBuiltInThemeClient();

const app = mount(App, { target: document.getElementById('app')! });
export default app;
