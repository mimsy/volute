import { mount } from "svelte";
import App from "./App.svelte";
import "@volute/ui/theme.css";
import "@volute/ui/base.css";
import "./app.css";

mount(App, { target: document.getElementById("root")! });
