/** The part of autocannon (MIT, no types of its own) that the load process uses. */
declare module "autocannon" {
  interface Result {
    requests: { total: number }; non2xx: number; errors: number; timeouts: number; "2xx": number; "4xx": number; "5xx": number;
    latency: { p50: number; p90: number; p97_5: number; p99: number; max: number };
  }
  interface Options {
    url: string; connections: number; overallRate: number; duration: number; timeout: number;
    requests: { method: "GET"; path: string; setupRequest: (req: { headers?: Record<string, string> }) => { headers?: Record<string, string> } }[];
  }
  export default function autocannon(options: Options): Promise<Result>;
}
