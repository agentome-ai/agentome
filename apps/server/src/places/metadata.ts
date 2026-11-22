/**
 * The clouds' own metadata services outside link-local, wherever they are: Alibaba's, Azure's
 * wire server, and over IPv6 AWS's, its pod identity agent and Google Cloud's (under fc00::/7,
 * which an exact name may otherwise reach). Whatever name resolves to them, never; the MCP
 * library's servers neither.
 */
export const METADATA = {
  ipv4: ['100.100.100.200', '168.63.129.16'],
  ipv6: ['fd00:ec2::254', 'fd00:ec2::23', 'fd20:ce::254'],
} as const;
