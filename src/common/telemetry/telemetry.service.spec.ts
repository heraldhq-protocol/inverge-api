import { TelemetryService } from './telemetry.service';

describe('TelemetryService (§4.6)', () => {
  it('renders counters with sorted, escaped labels', () => {
    const telemetry = new TelemetryService();
    telemetry.inc('http_requests_total', { status: '200', route: '/ideas' });
    telemetry.inc('http_requests_total', { status: '200', route: '/ideas' }, 2);

    expect(telemetry.render()).toContain(
      '# TYPE http_requests_total counter\nhttp_requests_total{route="/ideas",status="200"} 3',
    );
  });

  it('renders cumulative histogram buckets, sum and count', () => {
    const telemetry = new TelemetryService();
    telemetry.observe('http_request_duration_seconds', 0.03, { route: '/x' });
    telemetry.observe('http_request_duration_seconds', 2, { route: '/x' });

    const text = telemetry.render();
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="0.05",route="/x"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="+Inf",route="/x"} 2',
    );
    expect(text).toContain('http_request_duration_seconds_count{route="/x"} 2');
    expect(text).toContain('http_request_duration_seconds_sum{route="/x"} 2.03');
  });

  it('escapes quotes and newlines so one label cannot inject a series', () => {
    const telemetry = new TelemetryService();
    telemetry.inc('x_total', { route: '/a"b\nc' });

    expect(telemetry.render()).toContain('x_total{route="/a_b_c"} 1');
    expect(telemetry.render().split('\n').filter(Boolean)).toHaveLength(2);
  });
});
