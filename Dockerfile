FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY FootballTodayWeb.csproj .
RUN dotnet restore FootballTodayWeb.csproj
COPY . .
RUN dotnet publish FootballTodayWeb.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app .
EXPOSE 10000
ENTRYPOINT ["sh", "-c", "ASPNETCORE_URLS=http://+:${PORT:-10000} dotnet FootballTodayWeb.dll"]
