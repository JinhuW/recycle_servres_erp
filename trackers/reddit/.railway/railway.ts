import { defineRailway, postgres, project, service, volume } from "railway/iac";

// Both app services build from the Dockerfile: there is no build step (tsx runs
// the TS source) and node must be PID 1. The worker has no HTTP surface, so
// neither service gets a healthcheck here. Variables stay on Railway
// (`managed: false`); this file never reads or writes them.
//
// This is a whole-project file: a resource left out of `resources` is deleted
// by `railway config apply`. Keep Postgres and its volumes listed.
export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-east4-eqdc4a" });
  Postgres.deploy = { limitOverride: { containers: { cpu: 6, memoryBytes: 6000000000 } }, multiRegionConfig: { "us-east4-eqdc4a": { numReplicas: 1 } } };
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const postgresVolumeGYo0 = volume("postgres-volume-GYo0", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 50000 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 50000 });
  const api = service("api", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: { restartPolicyType: "ON_FAILURE" },
    replicas: { "us-east4-eqdc4a": 1 },
  });
  const worker = service("worker", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: { restartPolicyType: "ON_FAILURE" },
    replicas: { "us-east4-eqdc4a": 1 },
  });

  return project("reddits-tracker", {
    variables: { managed: false },
    resources: [api, Postgres, worker, postgresVolumeGYo0, postgresVolume],
  });
});
