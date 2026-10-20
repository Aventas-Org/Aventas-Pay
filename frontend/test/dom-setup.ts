/**
 * Registers a DOM environment for component tests. Loaded before every test
 * file via bunfig.toml [test] preload.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// React 18 requires this flag for act() to work outside a real renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
