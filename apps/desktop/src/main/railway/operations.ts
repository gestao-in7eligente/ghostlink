// Every Railway operation the app sends, copied from the API research (railway-api.md,
// validated against the live schema of 2026-09-29), with the part of each answer we read.
// Some select fewer fields than the research documents; none selects a field it lacks.
import { z } from 'zod';
import type { Operation } from './api.js';

const id = z.string().min(1).max(128);
const logLines = z.array(z.object({ timestamp: z.string().nullish(), message: z.string() })).max(5_000);

export const OPS = {
  // §2.1: any Bearer token (account, workspace or OAuth).
  apiToken: {
    name: 'ApiTokenContext',
    retry: 'query',
    doc: `query ApiTokenContext {
  apiToken {
    workspaces { id name }
  }
}`,
  },
  // §2.1: account and OAuth tokens only (the fallback).
  me: {
    name: 'Me',
    retry: 'query',
    doc: `query Me {
  me {
    workspaces { id name plan }
  }
}`,
  },
  // §2.1 "detect a trial account"; billing may need the Admin role (not verified).
  workspacePlan: {
    name: 'WorkspaceBilling',
    retry: 'query',
    doc: `query WorkspaceBilling($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) {
    id
    plan
    customer {
      isTrialing
    }
  }
}`,
  },
  // §3.1
  projectCreate: {
    name: 'ProjectCreate',
    retry: 'never',
    doc: `mutation ProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    id
    name
    workspaceId
    baseEnvironmentId
    primaryEnvironmentId
    environments {
      edges { node { id name } }
    }
  }
}`,
  },
  // §3.2
  project: {
    name: 'Project',
    retry: 'query',
    doc: `query Project($id: String!) {
  project(id: $id) {
    id
    deletedAt
  }
}`,
  },
  // §3.3: deleting twice ends in the same state.
  projectDelete: {
    name: 'ProjectDelete',
    retry: 'idempotent',
    doc: `mutation ProjectDelete($id: String!) {
  projectDelete(id: $id)
}`,
  },
  // §4.1
  serviceCreate: {
    name: 'ServiceCreate',
    retry: 'never',
    doc: `mutation ServiceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) {
    id
    name
  }
}`,
  },
  // §4.2
  serviceInstanceUpdate: {
    name: 'ServiceInstanceUpdate',
    retry: 'idempotent',
    doc: `mutation ServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`,
  },
  // §6
  volumeCreate: {
    name: 'VolumeCreate',
    retry: 'never',
    doc: `mutation VolumeCreate($input: VolumeCreateInput!) {
  volumeCreate(input: $input) {
    id
    name
  }
}`,
  },
  // §6 (environment.volumeInstances; Volume.volumeInstances is deprecated)
  environmentVolumes: {
    name: 'EnvironmentVolumes',
    retry: 'query',
    doc: `query EnvironmentVolumes($id: String!) {
  environment(id: $id) {
    volumeInstances {
      edges {
        node {
          id
          volumeId
          serviceId
          mountPath
        }
      }
    }
  }
}`,
  },
  // §4.3 / §7.1: the TCP proxy is a staged-changes patch (tcpProxyCreate is deprecated).
  environmentPatchCommit: {
    name: 'EnvironmentPatchCommit',
    retry: 'idempotent',
    doc: `mutation EnvironmentPatchCommit($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String, $skipDeploys: Boolean) {
  environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: $skipDeploys)
}`,
  },
  // §7.2
  tcpProxies: {
    name: 'TcpProxies',
    retry: 'query',
    doc: `query TcpProxies($environmentId: String!, $serviceId: String!) {
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
    id
    domain
    proxyPort
    applicationPort
    syncStatus
    deletedAt
  }
}`,
  },
  // §5
  variableCollectionUpsert: {
    name: 'VariableCollectionUpsert',
    retry: 'idempotent',
    doc: `mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`,
  },
  // §7.5
  domains: {
    name: 'Domains',
    retry: 'query',
    doc: `query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    serviceDomains { id domain targetPort }
    customDomains { id domain targetPort }
  }
}`,
  },
  // §7.5
  serviceDomainDelete: {
    name: 'ServiceDomainDelete',
    retry: 'idempotent',
    doc: `mutation ServiceDomainDelete($id: String!) {
  serviceDomainDelete(id: $id)
}`,
  },
  // §4.4
  serviceInstance: {
    name: 'ServiceInstance',
    retry: 'query',
    doc: `query ServiceInstance($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    id
    latestDeployment { id status createdAt }
  }
}`,
  },
  // §8
  serviceInstanceDeployV2: {
    name: 'ServiceInstanceDeployV2',
    retry: 'never',
    doc: `mutation ServiceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`,
  },
  // §8
  deployment: {
    name: 'Deployment',
    retry: 'query',
    doc: `query Deployment($id: String!) {
  deployment(id: $id) {
    id
    status
  }
}`,
  },
  // §8
  buildLogs: {
    name: 'BuildLogs',
    retry: 'query',
    doc: `query BuildLogs($deploymentId: String!, $limit: Int) {
  buildLogs(deploymentId: $deploymentId, limit: $limit) {
    timestamp
    message
    severity
  }
}`,
  },
  // §8
  deploymentLogs: {
    name: 'DeploymentLogs',
    retry: 'query',
    doc: `query DeploymentLogs($deploymentId: String!, $limit: Int, $filter: String) {
  deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
    timestamp
    message
    severity
  }
}`,
  },
} as const satisfies Record<string, Operation>;

/** The `data` of each operation, as far as the app reads it. */
export const DATA = {
  apiToken: z.object({ apiToken: z.object({ workspaces: z.array(z.object({ id, name: z.string().max(256) })) }) }),
  me: z.object({ me: z.object({ workspaces: z.array(z.object({ id, name: z.string().max(256), plan: z.string().nullish() })) }) }),
  workspacePlan: z.object({ workspace: z.object({ plan: z.string().nullish(), customer: z.object({ isTrialing: z.boolean() }) }) }),
  projectCreate: z.object({
    projectCreate: z.object({
      id,
      primaryEnvironmentId: id.nullish(),
      environments: z.object({ edges: z.array(z.object({ node: z.object({ id }) })) }),
    }),
  }),
  project: z.object({ project: z.object({ id, deletedAt: z.string().nullish() }) }),
  projectDelete: z.object({ projectDelete: z.boolean() }),
  serviceCreate: z.object({ serviceCreate: z.object({ id }) }),
  serviceInstanceUpdate: z.object({ serviceInstanceUpdate: z.boolean() }),
  volumeCreate: z.object({ volumeCreate: z.object({ id }) }),
  environmentVolumes: z.object({
    environment: z.object({
      volumeInstances: z.object({ edges: z.array(z.object({ node: z.object({ volumeId: id, serviceId: id.nullish(), mountPath: z.string() }) })) }),
    }),
  }),
  environmentPatchCommit: z.object({ environmentPatchCommit: z.string() }),
  tcpProxies: z.object({
    tcpProxies: z.array(
      z.object({ domain: z.string(), proxyPort: z.number().int(), applicationPort: z.number().int(), syncStatus: z.string(), deletedAt: z.string().nullish() }),
    ),
  }),
  variableCollectionUpsert: z.object({ variableCollectionUpsert: z.boolean() }),
  domains: z.object({ domains: z.object({ serviceDomains: z.array(z.object({ id })) }) }),
  serviceDomainDelete: z.object({ serviceDomainDelete: z.boolean() }),
  serviceInstance: z.object({ serviceInstance: z.object({ latestDeployment: z.object({ id, status: z.string() }).nullish() }) }),
  serviceInstanceDeployV2: z.object({ serviceInstanceDeployV2: id }),
  deployment: z.object({ deployment: z.object({ id, status: z.string() }) }),
  buildLogs: z.object({ buildLogs: logLines }),
  deploymentLogs: z.object({ deploymentLogs: logLines }),
};
