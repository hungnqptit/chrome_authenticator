// Decoder for Google Authenticator's "Transfer accounts" QR codes:
//   otpauth-migration://offline?data=<base64 protobuf MigrationPayload>
//
// message MigrationPayload {
//   repeated OtpParameters otp_parameters = 1;
//   int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5;
// }
// message OtpParameters {
//   bytes secret = 1; string name = 2; string issuer = 3;
//   Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; int64 counter = 7;
// }

const utf8 = new TextDecoder();

function readVarint(buf, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= buf.length) throw new Error('Dữ liệu migration bị cắt cụt');
    const b = buf[state.pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return result;
    shift += 7;
    if (shift > 63) throw new Error('Varint quá dài');
  }
}

function readFields(buf) {
  const state = { pos: 0 };
  const fields = [];
  while (state.pos < buf.length) {
    const tag = readVarint(buf, state);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      fields.push({ field, value: readVarint(buf, state) });
    } else if (wire === 2) {
      const len = readVarint(buf, state);
      if (state.pos + len > buf.length) throw new Error('Dữ liệu migration bị cắt cụt');
      fields.push({ field, value: buf.subarray(state.pos, state.pos + len) });
      state.pos += len;
    } else if (wire === 1) {
      state.pos += 8;
    } else if (wire === 5) {
      state.pos += 4;
    } else {
      throw new Error(`Wire type không hỗ trợ: ${wire}`);
    }
  }
  return fields;
}

function decodeOtpParameters(bytes) {
  const p = { secret: new Uint8Array(), name: '', issuer: '', algorithm: 0, digits: 0, type: 0, counter: 0 };
  for (const { field, value } of readFields(bytes)) {
    if (field === 1) p.secret = Uint8Array.from(value);
    else if (field === 2) p.name = utf8.decode(value);
    else if (field === 3) p.issuer = utf8.decode(value);
    else if (field === 4) p.algorithm = value;
    else if (field === 5) p.digits = value;
    else if (field === 6) p.type = value;
    else if (field === 7) p.counter = value;
  }
  return p;
}

export function decodeMigrationPayload(bytes) {
  const payload = { otpParameters: [], version: 0, batchSize: 1, batchIndex: 0, batchId: 0 };
  for (const { field, value } of readFields(bytes)) {
    if (field === 1) payload.otpParameters.push(decodeOtpParameters(value));
    else if (field === 2) payload.version = value;
    else if (field === 3) payload.batchSize = value;
    else if (field === 4) payload.batchIndex = value;
    else if (field === 5) payload.batchId = value;
  }
  return payload;
}

export function parseMigrationUri(uri) {
  // Read `data` by hand: URLSearchParams would turn a raw "+" into a space.
  const m = /[?&]data=([^&#]+)/.exec(uri);
  if (!m) throw new Error('URI migration thiếu tham số data');
  const b64 = decodeURIComponent(m[1]).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new Error('Tham số data không phải base64 hợp lệ');
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return decodeMigrationPayload(bytes);
}
