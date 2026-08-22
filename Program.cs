using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

var ApiFootballKey = ReadApiFootballKey();
const string ApiFootballBaseUrl = "https://v3.football.api-sports.io";
const string Timezone = "Asia/Ho_Chi_Minh";
var cacheTtl = TimeSpan.FromMinutes(20);
var maxConcurrentApiCalls = 6;

// Các giải đấu lớn được quét cho tính năng "trận đáng chú ý" - giới hạn để tiết kiệm quota API.
var majorLeagueIds = new HashSet<int>
{
    39, 40,      // England: Premier League, Championship
    140, 141,    // Spain: La Liga, Segunda División
    135, 136,    // Italy: Serie A, Serie B
    78, 79,      // Germany: Bundesliga, 2. Bundesliga
    61, 62,      // France: Ligue 1, Ligue 2
    94,          // Portugal: Primeira Liga
    88,          // Netherlands: Eredivisie
    144,         // Belgium: Jupiler Pro League
    203,         // Turkey: Süper Lig
    179,         // Scotland: Premiership
    235,         // Russia: Premier League
    333,         // Ukraine: Premier League
    197,         // Greece: Super League 1
    207,         // Switzerland: Super League
    218,         // Austria: Bundesliga
    119,         // Denmark: Superliga
    113,         // Sweden: Allsvenskan
    103,         // Norway: Eliteserien
    106,         // Poland: Ekstraklasa
    210,         // Croatia: HNL
    253,         // USA: MLS
    262,         // Mexico: Liga MX
    71, 72,      // Brazil: Serie A, Serie B
    128,         // Argentina: Liga Profesional
    265,         // Chile: Primera División
    239,         // Colombia: Primera A
    307,         // Saudi Arabia: Pro League
    98,          // Japan: J1 League
    292,         // South Korea: K League 1
    169,         // China: Super League
    188,         // Australia: A-League
    2, 3, 848    // UEFA Champions/Europa/Conference League
};

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("football", client =>
{
    client.BaseAddress = new Uri(ApiFootballBaseUrl);
    client.DefaultRequestHeaders.Add("x-apisports-key", ApiFootballKey);
});

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

app.Use(async (ctx, next) =>
{
    try
    {
        await next();
    }
    catch (Exception ex) when (!ctx.Response.HasStarted)
    {
        app.Logger.LogError(ex, "Unhandled exception on {Path}", ctx.Request.Path);
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new { error = ex.GetType().Name, message = ex.Message });
    }
});

var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
var apiCallLimiter = new SemaphoreSlim(maxConcurrentApiCalls);

var teamHistoryCache = new ConcurrentDictionary<int, CacheEntry<List<MatchDto>>>();
var h2hCache = new ConcurrentDictionary<string, CacheEntry<List<MatchDto>>>();
var fixturesByDayCache = new ConcurrentDictionary<string, CacheEntry<List<FixtureResult>>>();
var fixturesByDayLock = new SemaphoreSlim(1);

app.MapGet("/api/fixtures/today", async (IHttpClientFactory factory, int dayOffset) =>
{
    var fixtures = await GetFixturesForDayAsync(factory, dayOffset);
    var dto = fixtures
        .OrderBy(f => f.Fixture.Date)
        .Select(f => new
        {
            id = f.Fixture.Id,
            date = f.Fixture.Date,
            status = f.Fixture.Status?.Short,
            league = f.League.Name,
            leagueId = f.League.Id,
            leagueLogo = f.League.Logo,
            homeId = f.Teams.Home.Id,
            homeName = f.Teams.Home.Name,
            homeLogo = f.Teams.Home.Logo,
            awayId = f.Teams.Away.Id,
            awayName = f.Teams.Away.Name,
            awayLogo = f.Teams.Away.Logo,
            homeGoals = f.Goals.Home,
            awayGoals = f.Goals.Away
        });
    return Results.Json(dto);
});

app.MapGet("/api/matchup/{fixtureId:int}", async (int fixtureId, IHttpClientFactory factory) =>
{
    var http = factory.CreateClient("football");

    var fixtureResponse = await CallApiAsync<FixtureResult>(http, $"/fixtures?id={fixtureId}");
    var fixture = fixtureResponse.FirstOrDefault();
    if (fixture is null) return Results.NotFound(new { error = "Không tìm thấy trận đấu." });

    var homeTeam = fixture.Teams.Home;
    var awayTeam = fixture.Teams.Away;

    var homeHistoryTask = GetTeamLast10Async(http, homeTeam.Id);
    var awayHistoryTask = GetTeamLast10Async(http, awayTeam.Id);
    var h2hTask = GetHeadToHeadLast10Async(http, homeTeam.Id, awayTeam.Id);
    await Task.WhenAll(homeHistoryTask, awayHistoryTask, h2hTask);

    return Results.Json(new
    {
        teamA = new { id = homeTeam.Id, name = homeTeam.Name, logo = homeTeam.Logo, matches = ApplyHighlight(homeHistoryTask.Result, homeTeam.Id) },
        teamB = new { id = awayTeam.Id, name = awayTeam.Name, logo = awayTeam.Logo, matches = ApplyHighlight(awayHistoryTask.Result, awayTeam.Id) },
        headToHead = new { matches = ApplyHighlight(h2hTask.Result, null) }
    });
});

// Server-Sent Events: quét các trận thuộc giải đấu lớn trong ngày được chọn (dayOffset:
// 0 = hôm nay, 1 = ngày mai...), báo tiến độ và trả về từng trận thỏa điều kiện
// "1 trong 3 bảng có chênh lệch đỏ/xanh >= 3" ngay khi tính xong.
app.MapGet("/api/hot-matches/stream", async (HttpContext ctx, IHttpClientFactory factory, bool upcomingOnly, int dayOffset) =>
{
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";

    async Task SendEventAsync(string eventName, object data)
    {
        var json = JsonSerializer.Serialize(data);
        var payload = $"event: {eventName}\ndata: {json}\n\n";
        await ctx.Response.WriteAsync(payload, ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
    }

    var http = factory.CreateClient("football");
    var allFixtures = await GetFixturesForDayAsync(factory, dayOffset);
    var candidates = allFixtures
        .Where(f => majorLeagueIds.Contains(f.League.Id))
        .Where(f => !upcomingOnly || f.Fixture.Status?.Short == "NS")
        .ToList();

    await SendEventAsync("start", new { total = candidates.Count });

    var processed = 0;
    var tasks = candidates.Select(async fixture =>
    {
        try
        {
            var homeTeam = fixture.Teams.Home;
            var awayTeam = fixture.Teams.Away;

            var homeHistory = await GetTeamLast10Async(http, homeTeam.Id);
            var awayHistory = await GetTeamLast10Async(http, awayTeam.Id);
            var h2h = await GetHeadToHeadLast10Async(http, homeTeam.Id, awayTeam.Id);

            var (homeGreen, homeRed) = CountGreenRed(homeHistory);
            var (awayGreen, awayRed) = CountGreenRed(awayHistory);
            var (h2hGreen, h2hRed) = CountGreenRed(h2h);

            var maxDiff = new[] { Math.Abs(homeGreen - homeRed), Math.Abs(awayGreen - awayRed), Math.Abs(h2hGreen - h2hRed) }.Max();

            if (maxDiff >= 3)
            {
                await SendEventAsync("match", new
                {
                    id = fixture.Fixture.Id,
                    date = fixture.Fixture.Date,
                    status = fixture.Fixture.Status?.Short,
                    league = fixture.League.Name,
                    homeId = homeTeam.Id,
                    homeName = homeTeam.Name,
                    homeLogo = homeTeam.Logo,
                    awayId = awayTeam.Id,
                    awayName = awayTeam.Name,
                    awayLogo = awayTeam.Logo,
                    homeStats = new { green = homeGreen, red = homeRed },
                    awayStats = new { green = awayGreen, red = awayRed },
                    h2hStats = new { green = h2hGreen, red = h2hRed }
                });
            }
        }
        catch (Exception ex)
        {
            await SendEventAsync("error", new { fixtureId = fixture.Fixture.Id, message = ex.Message });
        }
        finally
        {
            var done = Interlocked.Increment(ref processed);
            await SendEventAsync("progress", new { processed = done, total = candidates.Count });
        }
    });

    await Task.WhenAll(tasks);
    await SendEventAsync("done", new { });
});

app.Run();

static string ReadApiFootballKey()
{
    var envKey = Environment.GetEnvironmentVariable("API_FOOTBALL_KEY");
    if (!string.IsNullOrWhiteSpace(envKey)) return envKey.Trim();

    var keyFilePath = Path.Combine(Directory.GetCurrentDirectory(), "apifootball_key.txt");
    if (File.Exists(keyFilePath))
    {
        var fileKey = File.ReadAllText(keyFilePath).Trim();
        if (!string.IsNullOrWhiteSpace(fileKey)) return fileKey;
    }

    throw new InvalidOperationException(
        "Chưa có API-Football key. Đặt biến môi trường API_FOOTBALL_KEY, hoặc tạo file apifootball_key.txt (cùng thư mục project) chứa key.");
}

async Task<List<FixtureResult>> GetFixturesForDayAsync(IHttpClientFactory factory, int dayOffset)
{
    var targetDate = DateTime.UtcNow.AddHours(7).AddDays(dayOffset).ToString("yyyy-MM-dd"); // Asia/Ho_Chi_Minh is UTC+7

    if (fixturesByDayCache.TryGetValue(targetDate, out var cached) && DateTime.UtcNow - cached.FetchedAt < TimeSpan.FromMinutes(2))
        return cached.Data;

    await fixturesByDayLock.WaitAsync();
    try
    {
        if (fixturesByDayCache.TryGetValue(targetDate, out cached) && DateTime.UtcNow - cached.FetchedAt < TimeSpan.FromMinutes(2))
            return cached.Data;

        var http = factory.CreateClient("football");
        var fixtures = await CallApiAsync<FixtureResult>(http,
            $"/fixtures?date={targetDate}&timezone={Uri.EscapeDataString(Timezone)}");
        fixturesByDayCache[targetDate] = new CacheEntry<List<FixtureResult>>(fixtures, DateTime.UtcNow);
        return fixtures;
    }
    finally
    {
        fixturesByDayLock.Release();
    }
}

async Task<List<MatchDto>> GetTeamLast10Async(HttpClient http, int teamId)
{
    if (teamHistoryCache.TryGetValue(teamId, out var cached) && DateTime.UtcNow - cached.FetchedAt < cacheTtl)
        return cached.Data;

    var matches = await FetchLastNWithScoreAsync(http, batchSize => $"/fixtures?team={teamId}&last={batchSize}", 10);
    teamHistoryCache[teamId] = new CacheEntry<List<MatchDto>>(matches, DateTime.UtcNow);
    return matches;
}

async Task<List<MatchDto>> GetHeadToHeadLast10Async(HttpClient http, int teamAId, int teamBId)
{
    var key = teamAId < teamBId ? $"{teamAId}-{teamBId}" : $"{teamBId}-{teamAId}";
    if (h2hCache.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.FetchedAt < cacheTtl)
        return cached.Data;

    var matches = await FetchLastNWithScoreAsync(http, batchSize => $"/fixtures/headtohead?h2h={teamAId}-{teamBId}&last={batchSize}", 10);
    h2hCache[key] = new CacheEntry<List<MatchDto>>(matches, DateTime.UtcNow);
    return matches;
}

// Trận bị hoãn/hủy hoặc chưa có tỉ số không tính là 1 trong 10 trận gần nhất - lấy thêm
// trận cũ hơn (last lớn hơn) để bù vào cho đủ 10 trận có tỉ số thật.
async Task<List<MatchDto>> FetchLastNWithScoreAsync(HttpClient http, Func<int, string> pathForBatchSize, int count)
{
    var batchSizes = new[] { count * 2, count * 4 };
    List<MatchDto> withScore = [];
    foreach (var batchSize in batchSizes)
    {
        var fixtures = await CallApiAsync<FixtureResult>(http, pathForBatchSize(batchSize));
        withScore = ToMatchDtos(fixtures)
            .Where(m => m.HomeGoals is not null && m.AwayGoals is not null)
            .Take(count)
            .ToList();
        if (withScore.Count >= count) break;
    }
    return withScore;
}

async Task<List<T>> CallApiAsync<T>(HttpClient http, string path)
{
    await apiCallLimiter.WaitAsync();
    try
    {
        var response = await http.GetFromJsonAsync<ApiResponse<T>>(path, jsonOptions);
        return response?.Response ?? [];
    }
    finally
    {
        apiCallLimiter.Release();
    }
}

static (int Green, int Red) CountGreenRed(List<MatchDto> matches)
{
    var green = 0;
    var red = 0;
    foreach (var m in matches)
    {
        if (m.HomeGoals is null || m.AwayGoals is null) continue;
        if (m.HomeGoals.Value + m.AwayGoals.Value > 2.5) red++;
        else green++;
    }
    return (green, red);
}

static List<MatchDto> ToMatchDtos(List<FixtureResult> fixtures) =>
    fixtures
        .OrderByDescending(f => f.Fixture.Date)
        .Select(f => new MatchDto(
            f.Fixture.Date,
            f.League.Name,
            f.Teams.Home.Id,
            f.Teams.Home.Name,
            f.Teams.Away.Id,
            f.Teams.Away.Name,
            f.Goals.Home,
            f.Goals.Away))
        .ToList();

static List<object> ApplyHighlight(List<MatchDto> matches, int? highlightTeamId) =>
    matches.Select(m => (object)new
    {
        date = m.Date,
        league = m.League,
        homeId = m.HomeId,
        homeName = m.HomeName,
        awayId = m.AwayId,
        awayName = m.AwayName,
        homeGoals = m.HomeGoals,
        awayGoals = m.AwayGoals,
        over25 = m.HomeGoals.HasValue && m.AwayGoals.HasValue && (m.HomeGoals.Value + m.AwayGoals.Value) > 2.5,
        highlightHome = highlightTeamId.HasValue && m.HomeId == highlightTeamId,
        highlightAway = highlightTeamId.HasValue && m.AwayId == highlightTeamId
    }).ToList();

record CacheEntry<T>(T Data, DateTime FetchedAt);

record MatchDto(
    DateTimeOffset Date,
    string League,
    int HomeId,
    string HomeName,
    int AwayId,
    string AwayName,
    int? HomeGoals,
    int? AwayGoals
);

record ApiResponse<T>(
    [property: JsonPropertyName("response")] List<T> Response
);

record FixtureResult(
    [property: JsonPropertyName("fixture")] FixtureInfo Fixture,
    [property: JsonPropertyName("league")] LeagueInfo League,
    [property: JsonPropertyName("teams")] TeamsInfo Teams,
    [property: JsonPropertyName("goals")] GoalsInfo Goals
);

record FixtureInfo(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("date")] DateTimeOffset Date,
    [property: JsonPropertyName("status")] StatusInfo? Status
);

record StatusInfo(
    [property: JsonPropertyName("short")] string? Short
);

record LeagueInfo(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("logo")] string? Logo
);

record TeamsInfo(
    [property: JsonPropertyName("home")] TeamSide Home,
    [property: JsonPropertyName("away")] TeamSide Away
);

record TeamSide(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("logo")] string? Logo
);

record GoalsInfo(
    [property: JsonPropertyName("home")] int? Home,
    [property: JsonPropertyName("away")] int? Away
);
