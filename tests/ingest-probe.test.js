import { describe, expect, it } from 'vitest';
import { classifyMediaProbe } from '../scripts/server/ffmpeg-helpers.ts';

// classifyMediaProbe turns a `-print_format json` ffprobe result into media
// info + the ingest conform flags. Absent fields = unset (CFR / SDR / no rotation).

describe('classifyMediaProbe — base fields', () => {
  it('parses width/height/fps and prefers format duration', () => {
    const info = classifyMediaProbe({
      streams: [{ width: 1080, height: 1920, r_frame_rate: '60/1', avg_frame_rate: '60/1', duration: '2.5' }],
      format: { duration: '3.0' },
    });
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.fps).toBe(60);
    expect(info.duration).toBe(3.0); // format duration wins over stream duration
  });

  it('returns safe defaults on empty/malformed input', () => {
    expect(classifyMediaProbe({})).toEqual({ width: 0, height: 0, duration: 0, fps: 0, vfr: false, hdr: false, rotation: 0 });
    expect(classifyMediaProbe(null)).toEqual({ width: 0, height: 0, duration: 0, fps: 0, vfr: false, hdr: false, rotation: 0 });
  });

  it('handles NTSC fractional rates as CFR (r == avg)', () => {
    const info = classifyMediaProbe({ streams: [{ r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' }] });
    expect(info.vfr).toBe(false);
    expect(info.fps).toBeCloseTo(29.97, 2);
  });
});

describe('classifyMediaProbe — VFR', () => {
  it('flags VFR when avg_frame_rate diverges from r_frame_rate', () => {
    const info = classifyMediaProbe({ streams: [{ r_frame_rate: '60/1', avg_frame_rate: '43/1' }] });
    expect(info.vfr).toBe(true);
  });

  it('does not flag CFR', () => {
    expect(classifyMediaProbe({ streams: [{ r_frame_rate: '30/1', avg_frame_rate: '30/1' }] }).vfr).toBe(false);
  });

  it('does not flag VFR when a rate is missing (0/0)', () => {
    expect(classifyMediaProbe({ streams: [{ r_frame_rate: '30/1', avg_frame_rate: '0/0' }] }).vfr).toBe(false);
  });
});

describe('classifyMediaProbe — HDR', () => {
  it('flags PQ (smpte2084)', () => {
    expect(classifyMediaProbe({ streams: [{ color_transfer: 'smpte2084' }] }).hdr).toBe(true);
  });

  it('flags HLG (arib-std-b67)', () => {
    expect(classifyMediaProbe({ streams: [{ color_transfer: 'arib-std-b67' }] }).hdr).toBe(true);
  });

  it('does NOT flag BT.2020 primaries with an SDR transfer', () => {
    // BT.2020 gamut alone is not HDR — the transfer function decides.
    expect(classifyMediaProbe({ streams: [{ color_primaries: 'bt2020', color_space: 'bt2020nc', color_transfer: 'bt709' }] }).hdr).toBe(false);
  });

  it('does not flag plain SDR / absent transfer', () => {
    expect(classifyMediaProbe({ streams: [{ color_transfer: 'bt709' }] }).hdr).toBe(false);
    expect(classifyMediaProbe({ streams: [{}] }).hdr).toBe(false);
  });
});

describe('classifyMediaProbe — rotation', () => {
  it('reads display-matrix side data and normalizes negative to [0,360)', () => {
    const info = classifyMediaProbe({ streams: [{ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }] });
    expect(info.rotation).toBe(270);
  });

  it('falls back to the legacy rotate tag', () => {
    expect(classifyMediaProbe({ streams: [{ tags: { rotate: '90' } }] }).rotation).toBe(90);
  });

  it('prefers side data over the legacy tag', () => {
    const info = classifyMediaProbe({ streams: [{ side_data_list: [{ rotation: 180 }], tags: { rotate: '90' } }] });
    expect(info.rotation).toBe(180);
  });

  it('defaults to 0 with no rotation info', () => {
    expect(classifyMediaProbe({ streams: [{ width: 640, height: 480 }] }).rotation).toBe(0);
  });
});
