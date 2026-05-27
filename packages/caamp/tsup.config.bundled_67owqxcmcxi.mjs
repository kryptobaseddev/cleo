// tsup.config.ts
import { defineConfig } from "tsup";
var tsup_config_default = defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts"
  },
  format: ["esm"],
  target: "node20",
  dts: {
    compilerOptions: {
      composite: false,
      // tsup (via rollup-plugin-dts) injects a baseUrl into its internal
      // tsconfig, which TypeScript 6 flags as TS5101 (deprecated). We
      // silence the deprecation until the tsup/rollup-plugin-dts chain
      // catches up with TS 6+.
      ignoreDeprecations: "6.0"
    }
  },
  clean: true,
  splitting: true,
  sourcemap: true
});
export {
  tsup_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidHN1cC5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9faW5qZWN0ZWRfZmlsZW5hbWVfXyA9IFwiL21udC9wcm9qZWN0cy9jbGVvY29kZS9wYWNrYWdlcy9jYWFtcC90c3VwLmNvbmZpZy50c1wiO2NvbnN0IF9faW5qZWN0ZWRfZGlybmFtZV9fID0gXCIvbW50L3Byb2plY3RzL2NsZW9jb2RlL3BhY2thZ2VzL2NhYW1wXCI7Y29uc3QgX19pbmplY3RlZF9pbXBvcnRfbWV0YV91cmxfXyA9IFwiZmlsZTovLy9tbnQvcHJvamVjdHMvY2xlb2NvZGUvcGFja2FnZXMvY2FhbXAvdHN1cC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidHN1cFwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBlbnRyeToge1xuICAgIGNsaTogXCJzcmMvY2xpLnRzXCIsXG4gICAgaW5kZXg6IFwic3JjL2luZGV4LnRzXCIsXG4gIH0sXG4gIGZvcm1hdDogW1wiZXNtXCJdLFxuICB0YXJnZXQ6IFwibm9kZTIwXCIsXG4gIGR0czoge1xuICAgIGNvbXBpbGVyT3B0aW9uczoge1xuICAgICAgY29tcG9zaXRlOiBmYWxzZSxcbiAgICAgIC8vIHRzdXAgKHZpYSByb2xsdXAtcGx1Z2luLWR0cykgaW5qZWN0cyBhIGJhc2VVcmwgaW50byBpdHMgaW50ZXJuYWxcbiAgICAgIC8vIHRzY29uZmlnLCB3aGljaCBUeXBlU2NyaXB0IDYgZmxhZ3MgYXMgVFM1MTAxIChkZXByZWNhdGVkKS4gV2VcbiAgICAgIC8vIHNpbGVuY2UgdGhlIGRlcHJlY2F0aW9uIHVudGlsIHRoZSB0c3VwL3JvbGx1cC1wbHVnaW4tZHRzIGNoYWluXG4gICAgICAvLyBjYXRjaGVzIHVwIHdpdGggVFMgNisuXG4gICAgICBpZ25vcmVEZXByZWNhdGlvbnM6IFwiNi4wXCIsXG4gICAgfSxcbiAgfSxcbiAgY2xlYW46IHRydWUsXG4gIHNwbGl0dGluZzogdHJ1ZSxcbiAgc291cmNlbWFwOiB0cnVlLFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQTZQLFNBQVMsb0JBQW9CO0FBRTFSLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLE9BQU87QUFBQSxJQUNMLEtBQUs7QUFBQSxJQUNMLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxRQUFRLENBQUMsS0FBSztBQUFBLEVBQ2QsUUFBUTtBQUFBLEVBQ1IsS0FBSztBQUFBLElBQ0gsaUJBQWlCO0FBQUEsTUFDZixXQUFXO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxNQUtYLG9CQUFvQjtBQUFBLElBQ3RCO0FBQUEsRUFDRjtBQUFBLEVBQ0EsT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUNiLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
