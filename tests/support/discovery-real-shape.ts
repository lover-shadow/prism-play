// Minimal sanitized protocol-shape fixtures, not complete captured HTML.
// IDs, titles and URLs are synthetic; no signatures or live upstream targets.
export const query = '示例剧目';
export const sid = '9000000000000000001';
export const vids = Array.from({ length: 100 }, (_, index) => String(9000000000000000100n + BigInt(index)));
export const providerOrigin = 'https://source.example.test';
export const mediaOrigin = 'https://media.example.test';
export const serverConfigJson = JSON.stringify({ providers: { provider_s1: {
  origin: providerOrigin,
  originAllowlist: [providerOrigin],
  mediaAllowlist: [mediaOrigin],
  coverAllowlist: ['https://cover.example.test']
} } });

function html(route: string, page: Record<string, unknown>): string {
  return `<html><body><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { [route]: page } })};</script></body></html>`;
}
export const searchPage = {
  query, isSuccess: true,
  searchList: Array.from({ length: 10 }, (_, index) => ({
    // A search keyword is metadata, not an encryption key.
    keyword: query,
    video_data: { series_id: index === 0 ? sid : String(9000000000000000001n + BigInt(index)),
      series_name: index === 0 ? query : `示例剧目${index + 1}` }
  }))
};
export const detailPage = { seriesDetail: {
  series_id: sid, series_name: query, episode_cnt: 100, accessiblecnt: 3, vid_list: vids
} };
export const firstPlayer: Record<string, unknown> = {
  series_id: sid, vid: vids[0],
  video_player_info: { main_url: `${mediaOrigin}/video.mp4`, duration: 90 }
};
export const searchHtml = html('search_(query)/page', searchPage);
export const detailHtml = html('detail_(series_id)/page', detailPage);
export const playerHtml = html('player_(series_id)/(vid)/page', firstPlayer);
