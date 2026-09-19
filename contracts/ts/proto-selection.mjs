import { matchesGlob } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

// Read imports from protoc's descriptor, including public imports, rather than parsing proto source text.
export function selectProtoFiles(descriptorBytes, config, localFiles) {
  const languages = ["ts", "rust", "go"];
  if (!config || Object.keys(config).some((key) => !languages.includes(key))) {
    throw new Error("Proto generation config must contain only ts, rust and go");
  }
  const descriptors = fromBinary(FileDescriptorSetSchema, descriptorBytes);
  const dependencies = new Map(descriptors.file.map((file) => [file.name, file.dependency]));
  const local = new Set(localFiles);
  return Object.fromEntries(
    languages.map((language) => {
      const patterns = config[language];
      if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || !pattern)) {
        throw new Error(`Expected an array of proto patterns for ${language}`);
      }
      const selected = new Set();
      function visit(name) {
        if (!local.has(name) || selected.has(name)) return;
        if (!dependencies.has(name)) throw new Error(`Missing proto descriptor: ${name}`);
        selected.add(name);
        for (const dependency of dependencies.get(name)) visit(dependency);
      }
      for (const pattern of patterns) {
        const matches = localFiles.filter((name) => matchesGlob(name, pattern));
        if (!matches.length) throw new Error(`No proto files match ${language} pattern: ${pattern}`);
        for (const name of matches) visit(name);
      }
      return [language, [...selected].sort()];
    }),
  );
}
