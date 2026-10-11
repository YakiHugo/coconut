// Authored real file bytes, generated once with Python standard codecs.
export const encodingFixtures=[
  {
    "name": "utf8.srt",
    "base64": "MQ0KMDA6MDA6MDAsMTI1IC0tPiAwMDowMDowMiw3NTANCuS4reaWh+a1i+ivlQ0K56ys5LqM6KGMDQo=",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试\r\n第二行\r\n",
    "encoding": null
  },
  {
    "name": "utf8-bom.srt",
    "base64": "77u/MQ0KMDA6MDA6MDAsMTI1IC0tPiAwMDowMDowMiw3NTANCuS4reaWh+a1i+ivlQ0K56ys5LqM6KGMDQo=",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试\r\n第二行\r\n",
    "encoding": null
  },
  {
    "name": "utf16le.srt",
    "base64": "//4xAA0ACgAwADAAOgAwADAAOgAwADAALAAxADIANQAgAC0ALQA+ACAAMAAwADoAMAAwADoAMAAyACwANwA1ADAADQAKAC1Oh2VLbdWLDQAKACx7jE5MiA0ACgA=",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试\r\n第二行\r\n",
    "encoding": null
  },
  {
    "name": "utf16be.srt",
    "base64": "/v8AMQANAAoAMAAwADoAMAAwADoAMAAwACwAMQAyADUAIAAtAC0APgAgADAAMAA6ADAAMAA6ADAAMgAsADcANQAwAA0ACk4tZYdtS4vVAA0ACnssToyITAANAAo=",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试\r\n第二行\r\n",
    "encoding": null
  },
  {
    "name": "gb18030.srt",
    "base64": "MQ0KMDA6MDA6MDAsMTI1IC0tPiAwMDowMDowMiw3NTANCtbQzsSy4srUlTKCNg0Ktdq2/tDQDQo=",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试𠀀\r\n第二行\r\n",
    "encoding": "gb18030"
  },
  {
    "name": "big5.vtt",
    "base64": "V0VCVlRUDQoNCjAwOjAwOjAwLjEyNSAtLT4gMDA6MDA6MDIuNzUwDQqkpKTltPq41Q0KssSkR6bmDQo=",
    "text": "WEBVTT\r\n\r\n00:00:00.125 --> 00:00:02.750\r\n中文測試\r\n第二行\r\n",
    "encoding": "big5"
  },
  {
    "name": "western.srt",
    "base64": "MQ0KMDA6MDA6MDAsMTI1IC0tPiAwMDowMDowMiw3NTANCkNhZukgZOlq4CB2dQ0KqyBy6XN1bekguw0K",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\nCafé déjà vu\r\n« résumé »\r\n",
    "encoding": "windows-1252"
  },
  {
    "name": "utf16-unmarked.srt",
    "base64": "MQANAAoAMAAwADoAMAAwADoAMAAwACwAMQAyADUAIAAtAC0APgAgADAAMAA6ADAAMAA6ADAAMgAsADcANQAwAA0ACgAtTodlS23Viw0ACgAse4xOTIgNAAoA",
    "text": "1\r\n00:00:00,125 --> 00:00:02,750\r\n中文测试\r\n第二行\r\n",
    "encoding": "utf-16le"
  }
];
export const bytesFor=fixture=>Buffer.from(fixture.base64,"base64");
