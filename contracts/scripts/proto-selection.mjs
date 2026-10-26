import { matchesGlob } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

export function targetLayout(name) {
  const match = /^proto-[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(rs|ts|go|swift)$/.exec(name);
  if (!match) throw new Error(`Invalid proto target: ${name}`);

  const language = { rs: "rust", ts: "ts", go: "go", swift: "swift" }[match[1]];
  const output = `contracts/out/${name}`;
  const swiftModule = name
    .replace(/-swift$/, "")
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  const directory = {
    go: "gen",
    swift: `Sources/${swiftModule}/Generated`,
    rust: "src/gen",
    ts: "src/gen",
  }[language];
  const generated = `${output}/${directory}`;
  return { language, output, generated };
}

// File rules choose outputs; protoc remains authoritative for package identity and imports.
export function selectProtoFiles(descriptorBytes, config, localFiles) {
  if (!config || Object.keys(config).length !== 1 || !config.sources) {
    throw new Error("Proto generation config must contain only sources");
  }
  if (typeof config.sources !== "object" || Array.isArray(config.sources)) {
    throw new Error("Expected a source pattern to target-list mapping");
  }

  const rules = Object.entries(config.sources).map(([pattern, names]) => {
    if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..")) {
      throw new Error(`Invalid proto source pattern: ${pattern}`);
    }
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((name) => typeof name !== "string") ||
      new Set(names).size !== names.length
    ) {
      throw new Error(`Expected a nonempty, unique target list for ${pattern}`);
    }
    for (const name of names) targetLayout(name);
    return { pattern, names: [...names].sort(), matched: false };
  });

  const descriptors = fromBinary(FileDescriptorSetSchema, descriptorBytes);
  const files = new Map(descriptors.file.map((file) => [file.name, file]));
  const local = new Set(localFiles);
  const packages = new Map();
  for (const name of local) {
    const file = files.get(name);
    if (!file?.package) throw new Error(`Missing proto package or descriptor: ${name}`);

    const matched = rules.filter((rule) => {
      if (!matchesGlob(name, rule.pattern)) return false;
      rule.matched = true;
      return true;
    });
    const exact = matched.find((rule) => rule.pattern === name);
    const selected = exact ? [exact] : matched;
    if (!selected.length) throw new Error(`Missing output mapping for ${name}`);
    if (selected.some((rule) => JSON.stringify(rule.names) !== JSON.stringify(selected[0].names))) {
      throw new Error(`Conflicting source patterns for ${name}`);
    }

    const names = selected[0].names;
    const existing = packages.get(file.package);
    if (existing && JSON.stringify(existing.names) !== JSON.stringify(names)) {
      throw new Error(`Inconsistent outputs within proto package ${file.package}`);
    }
    if (!existing) packages.set(file.package, { names, files: [] });
    packages.get(file.package).files.push(name);
  }
  for (const rule of rules) {
    if (!rule.matched) throw new Error(`Proto source pattern matched no files: ${rule.pattern}`);
  }

  const targets = new Map();
  for (const [packageName, selected] of packages) {
    const providers = new Set();
    for (const name of selected.names) {
      const layout = targetLayout(name);
      if (providers.has(layout.language)) {
        throw new Error(`Multiple ${layout.language} type providers for ${packageName}`);
      }
      providers.add(layout.language);
      if (!targets.has(name)) targets.set(name, { ...layout, files: new Set() });
      for (const file of selected.files) targets.get(name).files.add(file);
    }
  }

  for (const [name, target] of targets) {
    for (const fileName of target.files) {
      for (const dependency of files.get(fileName).dependency) {
        if (!local.has(dependency)) {
          if (!files.has(dependency) || !dependency.startsWith("google/protobuf/")) {
            throw new Error(`Missing local proto import: ${dependency}`);
          }
        } else if (!target.files.has(dependency)) {
          throw new Error(`Cross-target proto import in ${name}: ${fileName} -> ${dependency}`);
        }
      }
    }
  }

  return Object.fromEntries(
    [...targets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, target]) => [
        name,
        {
          language: target.language,
          output: target.output,
          generated: target.generated,
          files: [...target.files].sort(),
        },
      ]),
  );
}
